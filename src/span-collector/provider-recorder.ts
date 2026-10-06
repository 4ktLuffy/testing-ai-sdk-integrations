import type { RuntimeFailure } from "../assessment/types.js";
import { readCassette, requestMatch, type CassetteSpec, type ProviderTruthMode } from "../provider/cassette.js";
/**
 * Records provider HTTP exchanges for provider-truth evaluation.
 *
 * The recorder forwards `/provider/:projectId/:upstream/*` to the configured
 * upstream API base and streams the response back unbuffered while keeping a
 * copy. If the client disconnects, the upstream response is still drained so
 * the recording is complete. Credentials are forwarded but never stored.
 */
import type { Context } from "hono";
import {
	recordedPath,
	recordedRequestHeaders,
	recordedResponseHeaders,
	type ProviderExchange,
} from "../provider/exchange.js";

export const PROVIDER_UPSTREAM_ENV = "SENTRY_ASSESSMENT_PROVIDER_UPSTREAM";
export const GOOGLE_UPSTREAM_ENV = "SENTRY_ASSESSMENT_GOOGLE_UPSTREAM";

/** Upstream API bases by route name. OpenRouter supports both OpenAI and Anthropic wires. */
export const defaultProviderUpstreams: Readonly<Record<string, string>> = {
	openrouter: "https://openrouter.ai/api/v1",
	google: "https://generativelanguage.googleapis.com",
};

/**
 * SENTRY_ASSESSMENT_PROVIDER_UPSTREAM replaces the OpenRouter API base for local
 * development against another OpenAI-compatible API, for example
 * https://api.groq.com/openai/v1. SENTRY_ASSESSMENT_GOOGLE_UPSTREAM does the same
 * for the Gemini API base, for example a local server replaying recorded responses.
 */
export function providerUpstreamsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const override = environment[PROVIDER_UPSTREAM_ENV];
	const googleOverride = environment[GOOGLE_UPSTREAM_ENV];
	return {
		...defaultProviderUpstreams,
		...(override ? { openrouter: override } : {}),
		...(googleOverride ? { google: googleOverride } : {}),
	};
}

const hopByHopRequestHeaders = [
	"host",
	"connection",
	"keep-alive",
	"content-length",
	"transfer-encoding",
	"accept-encoding",
];

const hopByHopResponseHeaders = [
	"connection",
	"keep-alive",
	"content-length",
	"content-encoding",
	"transfer-encoding",
];

async function drain(stream: ReadableStream<Uint8Array>, rawChunks: string[]): Promise<string> {
	const chunks: Buffer[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(Buffer.from(value));
		rawChunks.push(Buffer.from(value).toString("base64"));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ProviderRecorder {
	private readonly replay = new Map<string, Map<string, ProviderExchange[]>>();
	private readonly indices = new Map<string, Map<string, number>>();
	private readonly failures = new Map<string, RuntimeFailure[]>();
	private readonly exchanges = new Map<string, ProviderExchange[]>();
	private readonly sequences = new Map<string, number>();
	private readonly pending = new Map<string, Set<Promise<void>>>();
	private readonly openCalls = new Map<string, string>();

	constructor(
		private readonly resolveRun: (projectId: number) => string | undefined,
		private readonly upstreams: Readonly<Record<string, string>>,
		private readonly fetchUpstream: typeof fetch = fetch,
		private readonly mode: ProviderTruthMode = "record",
	) {}

	registerRun(runId: string): void {
		this.exchanges.set(runId, []);
		this.failures.set(runId, []);
		this.indices.set(runId, new Map());
		this.replay.delete(runId);
		this.sequences.set(runId, 0);
		this.pending.set(runId, new Set());
		this.openCalls.delete(runId);
	}

	getFailures(runId: string): RuntimeFailure[] { return [...(this.failures.get(runId) ?? [])]; }

	async prepareReplay(runId: string, specs: Record<string, CassetteSpec>): Promise<void> {
		const calls = new Map<string, ProviderExchange[]>();
		this.replay.set(runId, calls);
		for (const [probeId, spec] of Object.entries(specs)) {
			try {
				const cassette = await readCassette(spec);
				for (const exchange of (cassette?.exchanges ?? []).sort((a, b) => a.sequence - b.sequence)) {
					if (!exchange.callId) continue;
					const list = calls.get(exchange.callId) ?? [];
					list.push(exchange);
					calls.set(exchange.callId, list);
				}
			} catch (error) {
				this.failures.get(runId)!.push({ kind: "setup", probeId, stopsVariant: true,
					message: `cassette is stale, re-record: ${errorMessage(error)}` });
			}
		}
	}

	private replayResponse(runId: string, exchange: ProviderExchange): Response {
		const callId = exchange.callId ?? "";
		const probeId = callId.split(":", 1)[0];
		const indices = this.indices.get(runId)!;
		const index = indices.get(callId) ?? 0;
		indices.set(callId, index + 1);
		const recorded = this.replay.get(runId)?.get(callId)?.[index];
		const match = recorded ? requestMatch(recorded, exchange) : "mismatch";
		if (!recorded || match === "mismatch" || this.getFailures(runId).some((failure) => failure.kind === "setup" && failure.probeId === probeId)) {
			const message = `No matching provider cassette exchange for ${callId} at index ${index}`;
			this.failures.get(runId)!.push({ kind: "provider", probeId, message, stopsVariant: true });
			exchange.status = 599;
			exchange.error = message;
			exchange.responseHeaders = { "content-type": "application/json" };
			exchange.responseBody = JSON.stringify({ error: message });
		} else {
			if (match === "drift") this.failures.get(runId)!.push({ kind: "provider_cassette_drift", probeId,
				message: `Provider request differs from cassette for ${callId} at index ${index}`, stopsVariant: false });
			exchange.status = recorded.status;
			exchange.responseHeaders = recorded.responseHeaders;
			exchange.responseBody = recorded.responseBody;
			exchange.responseChunks = recorded.responseChunks;
		}
		this.store(runId, exchange);
		const responseBody = exchange.responseChunks ? new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of exchange.responseChunks!) controller.enqueue(Buffer.from(chunk, "base64"));
				controller.close();
			},
		}) : exchange.responseBody;
		return new Response([204, 205, 304].includes(exchange.status) ? null : responseBody,
			{ status: exchange.status, headers: exchange.responseHeaders });
	}

	/** Exchanges recorded so far, ordered by request start. */
	getExchanges(runId: string): ProviderExchange[] {
		return [...(this.exchanges.get(runId) ?? [])].sort(
			(left, right) => left.sequence - right.sequence,
		);
	}

	/** Wait for in-flight recordings. Returns false when they did not finish in time. */
	async settle(runId: string, timeoutMs = 30_000): Promise<boolean> {
		const pending = [...(this.pending.get(runId) ?? [])];
		if (pending.length === 0) return true;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		const settled = await Promise.race([
			Promise.allSettled(pending).then(() => true as const),
			timeout,
		]);
		clearTimeout(timer);
		return settled;
	}

	private runFor(context: Context): string | undefined {
		const value = context.req.param("projectId");
		const projectId = value ? Number.parseInt(value, 10) : Number.NaN;
		return Number.isInteger(projectId) ? this.resolveRun(projectId) : undefined;
	}

	/** POST /provider/:projectId/_call?id=<callId>&phase=start|end */
	handleCallMarker(context: Context): Response {
		const runId = this.runFor(context);
		if (!runId || !this.exchanges.has(runId)) {
			return context.json({ error: "Unknown run" }, 404);
		}
		const callId = context.req.query("id");
		const phase = context.req.query("phase");
		if (!callId || (phase !== "start" && phase !== "end")) {
			return context.json({ error: "Invalid call marker" }, 400);
		}
		if (phase === "start") {
			this.openCalls.set(runId, callId);
		} else if (this.openCalls.get(runId) === callId) {
			this.openCalls.delete(runId);
		}
		return context.json({ status: "ok" });
	}

	private store(runId: string, exchange: ProviderExchange): void {
		exchange.finishedAt = new Date().toISOString();
		const exchanges = this.exchanges.get(runId) ?? [];
		exchanges.push(exchange);
		this.exchanges.set(runId, exchanges);
	}

	private track(runId: string, recording: Promise<void>): void {
		const pending = this.pending.get(runId) ?? new Set();
		pending.add(recording);
		this.pending.set(runId, pending);
		void recording.finally(() => pending.delete(recording));
	}

	/** ALL /provider/:projectId/:upstream/* */
	async handleProxy(context: Context): Promise<Response> {
		const runId = this.runFor(context);
		const upstreamName = context.req.param("upstream") ?? "";
		const base = this.upstreams[upstreamName];
		if (!runId || !this.exchanges.has(runId) || !base) {
			return context.json({ error: "Unknown provider route" }, 404);
		}

		const url = new URL(context.req.url);
		const prefix = `/provider/${context.req.param("projectId")}/${upstreamName}`;
		const rest = url.pathname.slice(prefix.length);
		const apiBase = base.replace(/\/+$/, "");
		const targetBase = upstreamName === "openrouter" && rest === "/v1/messages"
			? apiBase.replace(/\/v1$/, "")
			: apiBase;
		const target = `${targetBase}${rest}${url.search}`;
		const method = context.req.method;
		const body =
			method === "GET" || method === "HEAD"
				? undefined
				: Buffer.from(await context.req.arrayBuffer());
		const headers = new Headers(context.req.raw.headers);
		for (const name of hopByHopRequestHeaders) headers.delete(name);
		headers.set("accept-encoding", "identity");

		const sequence = this.sequences.get(runId) ?? 0;
		this.sequences.set(runId, sequence + 1);
		const exchange: ProviderExchange = {
			sequence,
			callId: this.openCalls.get(runId),
			upstream: upstreamName,
			method,
			path: recordedPath(rest, url.search),
			status: 0,
			requestHeaders: recordedRequestHeaders(context.req.raw.headers),
			responseHeaders: {},
			requestBody: body && body.length > 0 ? body.toString("utf8") : undefined,
			responseBody: "",
			startedAt: new Date().toISOString(),
			finishedAt: "",
		};

		if (this.mode === "replay") return this.replayResponse(runId, exchange);

		let upstream: Response;
		try {
			upstream = await this.fetchUpstream(target, {
				method,
				headers,
				body,
				redirect: "manual",
			});
		} catch (error) {
			exchange.error = `Provider upstream request failed: ${errorMessage(error)}`;
			this.store(runId, exchange);
			return context.json({ error: exchange.error }, 502);
		}

		exchange.status = upstream.status;
		exchange.responseHeaders = recordedResponseHeaders(upstream.headers);
		const responseHeaders = new Headers(upstream.headers);
		for (const name of hopByHopResponseHeaders) responseHeaders.delete(name);

		if (!upstream.body) {
			this.store(runId, exchange);
			return new Response(null, {
				status: upstream.status,
				headers: responseHeaders,
			});
		}

		const [clientBranch, recordBranch] = upstream.body.tee();
		this.track(
			runId,
			drain(recordBranch, exchange.responseChunks = [])
				.then((text) => {
					exchange.responseBody = text;
				})
				.catch((error: unknown) => {
					exchange.error = `Provider response could not be recorded: ${errorMessage(error)}`;
				})
				.finally(() => this.store(runId, exchange)),
		);

		// Pass chunks through as they arrive. Cancelling this branch (client
		// disconnect) does not cancel the upstream: the record branch keeps draining.
		const reader = clientBranch.getReader();
		const passthrough = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (done) controller.close();
						else controller.enqueue(value);
					} catch (error) {
						controller.error(error);
					}
				},
				cancel(reason) {
					exchange.clientDisconnected = true;
					return reader.cancel(reason);
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(passthrough, {
			status: upstream.status,
			headers: responseHeaders,
		});
	}
}
