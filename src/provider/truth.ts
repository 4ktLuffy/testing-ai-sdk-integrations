/**
 * Ground truth from recorded provider responses.
 *
 * Usage is read the way a correct consumer must: from the provider's own final
 * usage report. Some providers repeat the usage block on more than one stream
 * chunk (Groq sends it on the last content chunk and again on a usage-only
 * chunk). It is a running total, so the truth is the last report, never a sum.
 * Fields the provider did not report stay undefined and are never checked.
 *
 * Ported from SpanProof (spanproof/live.py and spanproof/fixtures.py).
 */
import type {
	ProviderCallSummary,
	ProviderExchangeSummary,
	ProviderUsage,
} from "../assessment/types.js";
import type { ProviderExchange } from "./exchange.js";

type JsonRecord = Record<string, unknown>;

export interface ProviderTruth {
	api: "chat" | "responses" | "messages" | "generateContent";
	streaming: boolean;
	usage?: ProviderUsage;
	model?: string;
	responseId?: string;
	finishReason?: string;
	terminalEvent?: string;
	incompleteReason?: string;
	/** The response asked for tool calls (set only when true). */
	toolCalls?: boolean;
}

const responsesTerminalEvents = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact(usage: ProviderUsage): ProviderUsage | undefined {
	const entries = Object.entries(usage).filter(
		([, value]) => value !== undefined,
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function details(value: unknown): JsonRecord {
	return isRecord(value) ? value : {};
}

/** OpenAI chat usage: prompt_tokens already includes cached tokens. */
export function chatUsage(usage: JsonRecord): ProviderUsage | undefined {
	const prompt = details(usage.prompt_tokens_details);
	const completion = details(usage.completion_tokens_details);
	return compact({
		input: count(usage.prompt_tokens),
		output: count(usage.completion_tokens),
		total: count(usage.total_tokens),
		cached: count(prompt.cached_tokens),
		cacheWrite: count(prompt.cache_write_tokens),
		reasoning: count(completion.reasoning_tokens),
	});
}

/** OpenAI Responses usage: input_tokens already includes cached tokens. */
export function responsesUsage(usage: JsonRecord): ProviderUsage | undefined {
	const input = details(usage.input_tokens_details);
	const output = details(usage.output_tokens_details);
	return compact({
		input: count(usage.input_tokens),
		output: count(usage.output_tokens),
		total: count(usage.total_tokens),
		cached: count(input.cached_tokens),
		cacheWrite: count(input.cache_write_tokens),
		reasoning: count(output.reasoning_tokens),
	});
}

export interface ServerSentEvent {
	event?: string;
	data: string;
}

/** Parse a text/event-stream body into events. */
export function parseServerSentEvents(raw: string): ServerSentEvent[] {
	const events: ServerSentEvent[] = [];
	let event: string | undefined;
	let data: string[] = [];
	const flush = () => {
		if (data.length > 0) events.push({ event, data: data.join("\n") });
		event = undefined;
		data = [];
	};
	for (const line of raw.split(/\r?\n/)) {
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		let value = separator === -1 ? "" : line.slice(separator + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") data.push(value);
		else if (field === "event") event = value;
	}
	flush();
	return events;
}

function jsonEvents(raw: string): JsonRecord[] {
	return parseServerSentEvents(raw).flatMap((event) => {
		if (event.data.trim() === "[DONE]") return [];
		try {
			const parsed: unknown = JSON.parse(event.data);
			return isRecord(parsed) ? [parsed] : [];
		} catch {
			return [];
		}
	});
}

function apiFor(upstream: string, path: string): ProviderTruth["api"] | undefined {
	const pathname = path.split("?", 1)[0].replace(/\/+$/, "");
	if (upstream === "google" && /:streamGenerateContent$|:generateContent$/.test(pathname)) return "generateContent";
	if (upstream !== "openrouter") return undefined;
	if (pathname === "/v1/messages") return "messages";
	if (pathname.endsWith("/chat/completions")) return "chat";
	if (pathname.endsWith("/responses")) return "responses";
	return undefined;
}

function isEventStream(contentType: string | undefined, body: string): boolean {
	if (contentType?.includes("text/event-stream")) return true;
	const start = body.trimStart();
	return start.startsWith("data:") || start.startsWith("event:");
}

function chatStreamTruth(raw: string): ProviderTruth {
	const truth: ProviderTruth = { api: "chat", streaming: true };
	for (const chunk of jsonEvents(raw)) {
		truth.model = text(chunk.model) ?? truth.model;
		truth.responseId = text(chunk.id) ?? truth.responseId;
		for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
			if (isRecord(choice)) {
				truth.finishReason = text(choice.finish_reason) ?? truth.finishReason;
				if (
					isRecord(choice.delta) &&
					Array.isArray(choice.delta.tool_calls) &&
					choice.delta.tool_calls.length > 0
				) {
					truth.toolCalls = true;
				}
			}
		}
		const usage = isRecord(chunk.usage)
			? chunk.usage
			: isRecord(chunk.x_groq) && isRecord(chunk.x_groq.usage)
				? chunk.x_groq.usage
				: undefined;
		// A running total: keep the last report, never sum.
		if (usage) truth.usage = chatUsage(usage);
	}
	return truth;
}

function chatTruth(body: JsonRecord): ProviderTruth {
	const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
	const message = isRecord(choice) ? choice.message : undefined;
	return {
		api: "chat",
		streaming: false,
		usage: isRecord(body.usage) ? chatUsage(body.usage) : undefined,
		model: text(body.model),
		responseId: text(body.id),
		finishReason: isRecord(choice) ? text(choice.finish_reason) : undefined,
		...(isRecord(message) &&
		Array.isArray(message.tool_calls) &&
		message.tool_calls.length > 0
			? { toolCalls: true }
			: {}),
	};
}

function responseObjectTruth(
	response: JsonRecord,
	streaming: boolean,
	terminalEvent?: string,
): ProviderTruth {
	return {
		api: "responses",
		streaming,
		usage: isRecord(response.usage)
			? responsesUsage(response.usage)
			: undefined,
		model: text(response.model),
		responseId: text(response.id),
		terminalEvent,
		...(Array.isArray(response.output) &&
		response.output.some(
			(item) => isRecord(item) && item.type === "function_call",
		)
			? { toolCalls: true }
			: {}),
		...(isRecord(response.incomplete_details) &&
		text(response.incomplete_details.reason)
			? { incompleteReason: text(response.incomplete_details.reason) }
			: {}),
	};
}

function responsesStreamTruth(raw: string): ProviderTruth {
	let truth: ProviderTruth = { api: "responses", streaming: true };
	for (const event of jsonEvents(raw)) {
		const type = text(event.type);
		if (!isRecord(event.response)) continue;
		if (type && responsesTerminalEvents.has(type)) {
			truth = responseObjectTruth(event.response, true, type);
		} else if (!truth.terminalEvent) {
			truth.model = text(event.response.model) ?? truth.model;
			truth.responseId = text(event.response.id) ?? truth.responseId;
		}
	}
	return truth;
}

/** Anthropic input excludes cache reads and writes; Sentry input includes both. */
function anthropicUsage(usage: JsonRecord): ProviderUsage | undefined {
	const input = count(usage.input_tokens);
	const cached = count(usage.cache_read_input_tokens);
	const cacheWrite = count(usage.cache_creation_input_tokens);
	return compact({
		input: input === undefined ? undefined : input + (cached ?? 0) + (cacheWrite ?? 0),
		output: count(usage.output_tokens),
		cached,
		cacheWrite,
		reasoning: count(details(usage.output_tokens_details).thinking_tokens),
	});
}

function messagesTruth(chunks: JsonRecord[], streaming: boolean): ProviderTruth {
	const truth: ProviderTruth = { api: "messages", streaming };
	let usage: JsonRecord = {};
	for (const chunk of chunks) {
		const message = streaming ? details(chunk.message) : chunk;
		truth.model = text(message.model) ?? truth.model;
		truth.responseId = text(message.id) ?? truth.responseId;
		truth.finishReason = text(message.stop_reason) ?? truth.finishReason;
		if (!streaming || chunk.type === "message_start") {
			usage = { ...usage, ...details(message.usage) };
		} else if (chunk.type === "message_delta") {
			// Deltas report cumulative totals, and may update input fields too.
			usage = { ...usage, ...details(chunk.usage) };
			truth.finishReason = text(details(chunk.delta).stop_reason) ?? truth.finishReason;
		}
	}
	truth.usage = anthropicUsage(usage);
	return truth;
}

function geminiTruth(chunks: JsonRecord[], streaming: boolean): ProviderTruth {
	const truth: ProviderTruth = { api: "generateContent", streaming };
	for (const chunk of chunks) {
		truth.model = text(chunk.modelVersion) ?? truth.model;
		truth.responseId = text(chunk.responseId) ?? truth.responseId;
		const candidate = Array.isArray(chunk.candidates) ? details(chunk.candidates[0]) : {};
		truth.finishReason = text(candidate.finishReason) ?? truth.finishReason;
		if (!isRecord(chunk.usageMetadata)) continue;
		const usage = chunk.usageMetadata;
		const output = count(usage.candidatesTokenCount);
		const reasoning = count(usage.thoughtsTokenCount);
		truth.usage = compact({
			input: count(usage.promptTokenCount),
			output: output === undefined ? undefined : output + (reasoning ?? 0),
			cached: count(usage.cachedContentTokenCount),
			reasoning,
		});
	}
	return truth;
}

/** Normalize one recorded exchange, or undefined when it carries no provider truth. */
export function providerTruthFromExchange(
	exchange: Pick<
		ProviderExchange,
		"upstream" | "path" | "status" | "responseHeaders" | "responseBody"
	>,
): ProviderTruth | undefined {
	if (exchange.status < 200 || exchange.status >= 300) return undefined;
	const api = apiFor(exchange.upstream, exchange.path);
	if (!api) return undefined;
	const raw = exchange.responseBody;
	if (isEventStream(exchange.responseHeaders["content-type"], raw)) {
		if (api === "messages") return messagesTruth(jsonEvents(raw), true);
		if (api === "generateContent") return geminiTruth(jsonEvents(raw), true);
		return api === "chat" ? chatStreamTruth(raw) : responsesStreamTruth(raw);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (api === "generateContent") {
		const chunks = Array.isArray(body) ? body.filter(isRecord) : isRecord(body) ? [body] : [];
		return geminiTruth(chunks, Array.isArray(body) || exchange.path.includes(":streamGenerateContent"));
	}
	if (!isRecord(body)) return undefined;
	if (api === "messages") return messagesTruth([body], false);
	return api === "chat" ? chatTruth(body) : responseObjectTruth(body, false);
}

export function summarizeExchange(
	exchange: ProviderExchange,
): ProviderExchangeSummary {
	const truth = providerTruthFromExchange(exchange);
	const summary: ProviderExchangeSummary = {
		sequence: exchange.sequence,
		path: exchange.path,
		status: exchange.status,
		...(exchange.injectedFault
			? { injectedFault: exchange.injectedFault }
			: {}),
	};
	if (!truth) return summary;
	return Object.fromEntries(
		Object.entries({ ...summary, ...truth }).filter(
			([, value]) => value !== undefined,
		),
	) as unknown as ProviderExchangeSummary;
}

/** Group exchanges by assessment call. Exchanges outside any call are returned separately. */
export function summarizeProviderCalls(exchanges: readonly ProviderExchange[]): {
	calls: ProviderCallSummary[];
	unattributed: ProviderExchange[];
} {
	const calls = new Map<string, ProviderCallSummary>();
	const unattributed: ProviderExchange[] = [];
	for (const exchange of [...exchanges].sort(
		(left, right) => left.sequence - right.sequence,
	)) {
		if (!exchange.callId) {
			unattributed.push(exchange);
			continue;
		}
		const call = calls.get(exchange.callId) ?? {
			callId: exchange.callId,
			probeId: exchange.callId.split(":", 1)[0],
			exchanges: [],
		};
		call.exchanges.push(summarizeExchange(exchange));
		calls.set(exchange.callId, call);
	}
	return { calls: [...calls.values()], unattributed };
}
