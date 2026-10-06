import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Hono } from "hono";
import { ProviderRecorder, defaultProviderUpstreams, providerUpstreamsFromEnvironment } from "./provider-recorder.js";
import { SpanCollector } from "./server.js";

const secrets = {
	authorization: "Bearer sk-test-authorization-secret",
	"x-api-key": "test-x-api-key-secret",
	"x-goog-api-key": "test-goog-api-key-secret",
	query: "test-query-key-secret",
};

interface Upstream {
	url: string;
	server: Server;
	requests: Array<{ url?: string; headers: IncomingMessage["headers"]; body: string }>;
	/** Resolved by the test to let a streaming response continue. */
	release: () => void;
	finished: Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const requests: Upstream["requests"] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ url: request.url, headers: request.headers, body });
			if (!JSON.parse(body).stream) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						id: "chatcmpl-blocking",
						model: "upstream-model",
						choices: [{ finish_reason: "stop" }],
						usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(
				`data: ${JSON.stringify({ id: "chatcmpl-stream", model: "upstream-model", choices: [{ delta: { content: "Par" } }] })}\n\n`,
			);
			await released;
			response.write(
				`data: ${JSON.stringify({ id: "chatcmpl-stream", model: "upstream-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
			finish();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}/v1`, server, requests, release, finished };
}

async function withRecorder(
	run: (context: {
		collector: SpanCollector;
		upstream: Upstream;
		runId: string;
		base: string;
		marker: string;
	}) => Promise<void>,
): Promise<void> {
	const upstream = await startUpstream();
	const collector = new SpanCollector(0, {
		providerTruth: true,
		providerUpstreams: { openrouter: upstream.url },
	});
	await collector.start();
	try {
		const runId = "provider-recorder-test";
		collector.getDsn(runId);
		collector.registerRun(runId);
		const environment = collector.getProviderEnvironment(runId);
		await run({
			collector,
			upstream,
			runId,
			base: environment.SENTRY_ASSESSMENT_OPENROUTER_BASE,
			marker: environment.SENTRY_ASSESSMENT_PROVIDER_TRUTH_URL,
		});
	} finally {
		upstream.release();
		await collector.stop();
		upstream.server.closeAllConnections();
		await new Promise((resolve) => upstream.server.close(resolve));
	}
}

async function mark(marker: string, callId: string, phase: "start" | "end") {
	const response = await fetch(
		`${marker}/_call?${new URLSearchParams({ id: callId, phase })}`,
		{ method: "POST" },
	);
	assert.equal(response.status, 200);
}

test("records a call's exchange without storing credentials", async () => {
	await withRecorder(async ({ collector, upstream, runId, base, marker }) => {
		await mark(marker, "llm.baseline:blocking:0", "start");
		const response = await fetch(
			`${base}/chat/completions?key=${secrets.query}&api-version=1`,
			{
				method: "POST",
				headers: {
					authorization: secrets.authorization,
					"x-api-key": secrets["x-api-key"],
					"x-goog-api-key": secrets["x-goog-api-key"],
					"content-type": "application/json",
					"x-stainless-lang": "js",
				},
				body: JSON.stringify({ model: "m", messages: [] }),
			},
		);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).id, "chatcmpl-blocking");
		await mark(marker, "llm.baseline:blocking:0", "end");
		assert.equal(await collector.settleProviderExchanges(runId), true);

		// Control: the credentials really were on the wire and were forwarded.
		assert.equal(upstream.requests[0].headers.authorization, secrets.authorization);
		assert.equal(upstream.requests[0].headers["x-api-key"], secrets["x-api-key"]);
		assert.match(upstream.requests[0].url ?? "", /\/v1\/chat\/completions\?key=/);

		const exchanges = collector.getProviderExchanges(runId);
		assert.equal(exchanges.length, 1);
		const [exchange] = exchanges;
		assert.equal(exchange.callId, "llm.baseline:blocking:0");
		assert.equal(exchange.path, "/chat/completions?api-version=1");
		assert.equal(exchange.status, 200);
		assert.equal(exchange.requestHeaders["x-stainless-lang"], "js");
		const stored = JSON.stringify(exchanges);
		for (const secret of Object.values(secrets)) {
			assert.equal(stored.includes(secret), false, `stored ${secret}`);
		}
		for (const header of ["authorization", "x-api-key", "x-goog-api-key"]) {
			assert.equal(header in exchange.requestHeaders, false, header);
		}
	});
});

test("streams responses unbuffered and keeps draining after a client disconnect", async () => {
	await withRecorder(async ({ collector, upstream, runId, base, marker }) => {
		await mark(marker, "llm.baseline:streaming:0", "start");
		const controller = new AbortController();
		const response = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
			signal: controller.signal,
		});
		const reader = response.body!.getReader();
		// The upstream holds its second chunk until released: receiving the
		// first chunk here proves the proxy does not buffer the response.
		const first = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("first chunk was buffered")), 5_000),
			),
		]);
		assert.match(Buffer.from(first.value!).toString("utf8"), /"Par"/);
		controller.abort();
		await reader.cancel().catch(() => undefined);
		await mark(marker, "llm.baseline:streaming:0", "end");
		upstream.release();
		await upstream.finished;
		assert.equal(await collector.settleProviderExchanges(runId), true);

		const [exchange] = collector.getProviderExchanges(runId);
		assert.equal(exchange.callId, "llm.baseline:streaming:0");
		assert.equal(exchange.clientDisconnected, true);
		assert.match(exchange.responseBody, /"prompt_tokens":4/);
		assert.match(exchange.responseBody, /data: \[DONE\]/);
	});
});

test("exchanges outside call markers are not attributed to a call", async () => {
	await withRecorder(async ({ collector, runId, base, marker }) => {
		await mark(marker, "llm.baseline:blocking:0", "start");
		await mark(marker, "llm.baseline:blocking:0", "end");
		await (
			await fetch(`${base}/chat/completions`, {
				method: "POST",
				body: JSON.stringify({ model: "m", messages: [] }),
			})
		).text();
		await collector.settleProviderExchanges(runId);
		assert.equal(collector.getProviderExchanges(runId)[0].callId, undefined);
	});
});

test("provider truth is off by default", async () => {
	const collector = new SpanCollector();
	await collector.start();
	try {
		const runId = "provider-truth-off";
		const dsn = new URL(collector.getDsn(runId));
		collector.registerRun(runId);
		assert.deepEqual(collector.getProviderEnvironment(runId), {});
		const response = await fetch(
			`${dsn.origin}${dsn.pathname.replace(/^\//, "/provider/")}/_call?id=x&phase=start`,
			{ method: "POST" },
		);
		assert.equal(response.status, 404);
		assert.deepEqual(collector.getProviderExchanges(runId), []);
	} finally {
		await collector.stop();
	}
});

for (const [upstream, path, expected] of [
	["google", "/v1beta/models/gemini-2.5-flash:generateContent", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"],
	["openrouter", "/v1/messages", "https://openrouter.ai/api/v1/messages"],
	["openrouter", "/chat/completions", "https://openrouter.ai/api/v1/chat/completions"],
] as const) {
	test(`routes and redacts ${upstream} ${path}`, async () => {
		const forwarded: Array<{ url: string; headers: Headers }> = [];
		const recorder = new ProviderRecorder(() => "run", defaultProviderUpstreams, async (url, init) => {
			forwarded.push({ url: String(url), headers: new Headers(init?.headers) });
			return new Response('{"ok":true}', { headers: { "content-type": "application/json", "x-goog-api-key": secrets["x-goog-api-key"] } });
		});
		recorder.registerRun("run");
		const app = new Hono();
		app.all("/provider/:projectId/:upstream/*", (context) => recorder.handleProxy(context));
		const response = await app.request(`/provider/1/${upstream}${path}?key=${secrets.query}&alt=sse`, {
			method: "POST",
			headers: { "x-goog-api-key": secrets["x-goog-api-key"], "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(response.status, 200);
		await response.text();
		assert.equal(await recorder.settle("run"), true);
		// Negative control: secrets are forwarded to the provider, not removed from the request.
		assert.equal(forwarded[0].url, `${expected}?key=${secrets.query}&alt=sse`);
		assert.equal(forwarded[0].headers.get("x-goog-api-key"), secrets["x-goog-api-key"]);
		const [stored] = recorder.getExchanges("run");
		assert.equal(stored.upstream, upstream);
		assert.equal(stored.path, `${path}?alt=sse`);
		assert.equal("x-goog-api-key" in stored.requestHeaders, false);
		assert.equal("x-goog-api-key" in stored.responseHeaders, false);
		assert.equal(JSON.stringify(stored).includes(secrets.query), false);
		assert.equal(JSON.stringify(stored).includes(secrets["x-goog-api-key"]), false);
	});
}

test("upstream overrides replace only the named route", () => {
	const none = providerUpstreamsFromEnvironment({});
	assert.equal(none.google, "https://generativelanguage.googleapis.com");
	const both = providerUpstreamsFromEnvironment({
		SENTRY_ASSESSMENT_PROVIDER_UPSTREAM: "http://127.0.0.1:1/v1",
		SENTRY_ASSESSMENT_GOOGLE_UPSTREAM: "http://127.0.0.1:2",
	});
	assert.equal(both.openrouter, "http://127.0.0.1:1/v1");
	assert.equal(both.google, "http://127.0.0.1:2");
});
