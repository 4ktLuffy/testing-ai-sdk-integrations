import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderExchange } from "./exchange.js";
import {
	providerTruthFromExchange,
	summarizeProviderCalls,
} from "./truth.js";

function exchange(
	path: string,
	responseBody: string,
	options: Partial<ProviderExchange> = {},
): ProviderExchange {
	return {
		sequence: 0,
		callId: "llm.baseline:blocking:0",
		upstream: "openrouter",
		method: "POST",
		path,
		status: 200,
		requestHeaders: {},
		responseHeaders: { "content-type": "application/json" },
		responseBody,
		startedAt: "2026-10-06T00:00:00.000Z",
		finishedAt: "2026-10-06T00:00:01.000Z",
		...options,
	};
}

function sse(events: unknown[], named = false): string {
	return `${events
		.map((event) => {
			const data = `data: ${JSON.stringify(event)}\n\n`;
			const type = (event as { type?: string }).type;
			return named && type ? `event: ${type}\n${data}` : data;
		})
		.join("")}data: [DONE]\n\n`;
}

const chatUsage = {
	prompt_tokens: 1200,
	completion_tokens: 300,
	total_tokens: 1500,
	prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 },
	completion_tokens_details: { reasoning_tokens: 256, audio_tokens: 0 },
};

test("normalizes OpenAI chat usage with cached and reasoning tokens", () => {
	const truth = providerTruthFromExchange(
		exchange(
			"/chat/completions",
			JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion",
				model: "gpt-5-mini-2026-08-07",
				choices: [{ index: 0, finish_reason: "stop", message: {} }],
				usage: chatUsage,
			}),
		),
	);
	assert.deepEqual(truth, {
		api: "chat",
		streaming: false,
		usage: {
			input: 1200,
			output: 300,
			total: 1500,
			cached: 1024,
			reasoning: 256,
		},
		model: "gpt-5-mini-2026-08-07",
		responseId: "chatcmpl-1",
		finishReason: "stop",
	});
});

test("leaves unreported usage fields undefined", () => {
	const truth = providerTruthFromExchange(
		exchange(
			"/chat/completions",
			JSON.stringify({
				id: "chatcmpl-2",
				model: "m",
				choices: [{ finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
			}),
		),
	);
	assert.deepEqual(truth?.usage, { input: 10, output: 2, total: 12 });
	assert.equal("cached" in (truth?.usage ?? {}), false);
	assert.equal("reasoning" in (truth?.usage ?? {}), false);
	// Control: a body without usage reports no usage at all, not zeros.
	const withoutUsage = providerTruthFromExchange(
		exchange(
			"/chat/completions",
			JSON.stringify({ id: "x", model: "m", choices: [] }),
		),
	);
	assert.equal(withoutUsage?.usage, undefined);
});

test("takes the last usage report of a Groq-style stream, never the sum", () => {
	const usage = {
		prompt_tokens: 80,
		completion_tokens: 20,
		total_tokens: 100,
	};
	const base = { id: "chatcmpl-g", object: "chat.completion.chunk", model: "openai/gpt-oss-20b" };
	const body = sse([
		{ ...base, choices: [{ index: 0, delta: { content: "Paris" }, finish_reason: null }] },
		// Groq repeats the running total on the last content chunk...
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], x_groq: { usage } },
		// ...and again on the usage-only chunk.
		{ ...base, choices: [], usage },
	]);
	const truth = providerTruthFromExchange(
		exchange("/chat/completions", body, {
			responseHeaders: { "content-type": "text/event-stream" },
		}),
	);
	assert.equal(truth?.streaming, true);
	assert.deepEqual(truth?.usage, { input: 80, output: 20, total: 100 });
	// Negative control: summing every report would double count.
	assert.notEqual(truth?.usage?.input, 160);
	assert.equal(truth?.finishReason, "stop");
	assert.equal(truth?.responseId, "chatcmpl-g");
});

test("reads a running total that grows across stream chunks as its last value", () => {
	const base = { id: "c", model: "m" };
	const body = sse([
		{ ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
		{ ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } },
	]);
	const truth = providerTruthFromExchange(exchange("/chat/completions", body));
	assert.deepEqual(truth?.usage, { input: 5, output: 9, total: 14 });
});

function responseObject(status: string, usage: unknown) {
	return {
		id: "resp_1",
		object: "response",
		created_at: 1790000000,
		status,
		model: "gpt-5-mini-2026-08-07",
		output: [],
		usage,
	};
}

const responsesUsage = {
	input_tokens: 1500,
	input_tokens_details: { cached_tokens: 1280 },
	output_tokens: 400,
	output_tokens_details: { reasoning_tokens: 320 },
	total_tokens: 1900,
};

test("normalizes a blocking OpenAI Responses body", () => {
	const truth = providerTruthFromExchange(
		exchange("/responses", JSON.stringify(responseObject("completed", responsesUsage))),
	);
	assert.deepEqual(truth, {
		api: "responses",
		streaming: false,
		usage: { input: 1500, output: 400, total: 1900, cached: 1280, reasoning: 320 },
		model: "gpt-5-mini-2026-08-07",
		responseId: "resp_1",
		terminalEvent: undefined,
	});
});

for (const terminal of [
	"response.completed",
	"response.incomplete",
	"response.failed",
]) {
	test(`reads Responses stream usage from ${terminal}`, () => {
		const inProgress = responseObject("in_progress", null);
		const body = sse(
			[
				{ type: "response.created", sequence_number: 0, response: inProgress },
				{ type: "response.output_text.delta", sequence_number: 1, delta: "Paris" },
				{
					type: terminal,
					sequence_number: 2,
					response: responseObject(terminal.split(".")[1], responsesUsage),
				},
			],
			true,
		);
		const truth = providerTruthFromExchange(
			exchange("/responses", body, {
				responseHeaders: { "content-type": "text/event-stream; charset=utf-8" },
			}),
		);
		assert.equal(truth?.terminalEvent, terminal);
		assert.equal(truth?.usage?.input, 1500);
		assert.equal(truth?.usage?.reasoning, 320);
	});
}

test("a Responses stream without a terminal event has no usage", () => {
	const body = sse(
		[{ type: "response.created", response: responseObject("in_progress", null) }],
		true,
	);
	const truth = providerTruthFromExchange(
		exchange("/responses", body, {
			responseHeaders: { "content-type": "text/event-stream" },
		}),
	);
	assert.equal(truth?.usage, undefined);
	assert.equal(truth?.responseId, "resp_1");
});

test("failed HTTP exchanges and unknown APIs carry no truth", () => {
	const body = JSON.stringify({ usage: chatUsage, choices: [] });
	assert.equal(
		providerTruthFromExchange(exchange("/chat/completions", body, { status: 400 })),
		undefined,
	);
	assert.equal(providerTruthFromExchange(exchange("/models", body)), undefined);
	// Control: the same body on a successful chat exchange does.
	assert.ok(providerTruthFromExchange(exchange("/chat/completions", body)));
});

test("groups exchanges by call and keeps unattributed exchanges apart", () => {
	const body = JSON.stringify({ id: "c", choices: [], usage: chatUsage });
	const { calls, unattributed } = summarizeProviderCalls([
		exchange("/chat/completions", body, { sequence: 1, callId: "llm.multi_turn:blocking:1" }),
		exchange("/chat/completions", body, { sequence: 0, callId: "llm.multi_turn:blocking:0" }),
		exchange("/chat/completions", body, { sequence: 2, callId: undefined }),
	]);
	assert.deepEqual(
		calls.map((call) => [call.callId, call.probeId, call.exchanges.length]),
		[
			["llm.multi_turn:blocking:0", "llm.multi_turn", 1],
			["llm.multi_turn:blocking:1", "llm.multi_turn", 1],
		],
	);
	assert.equal(calls[0].exchanges[0].usage?.cached, 1024);
	assert.equal(unattributed.length, 1);
});

const anthropicUsage = {
	input_tokens: 40,
	cache_read_input_tokens: 2048,
	cache_creation_input_tokens: 512,
	output_tokens: 200,
};
const anthropicMessage = {
	id: "msg_1", model: "claude-sonnet-4", stop_reason: "end_turn", usage: anthropicUsage,
};

for (const streaming of [false, true]) {
	test(`normalizes Anthropic cache usage (${streaming ? "stream" : "blocking"})`, () => {
		const body = streaming ? sse([
			{ type: "message_start", message: { ...anthropicMessage, stop_reason: null, usage: { ...anthropicUsage, output_tokens: 1 } } },
			{ type: "content_block_delta", delta: { type: "text_delta", text: "Paris" } },
			{ type: "message_delta", usage: { output_tokens: 50 }, delta: {} },
			{ type: "message_delta", usage: { output_tokens: 200 }, delta: { stop_reason: "end_turn" } },
		], true) : JSON.stringify(anthropicMessage);
		const recorded = exchange("/v1/messages", body);
		const truth = providerTruthFromExchange(recorded);
		assert.deepEqual(truth, {
			api: "messages", streaming, model: "claude-sonnet-4", responseId: "msg_1", finishReason: "end_turn",
			usage: { input: 2600, output: 200, cached: 2048, cacheWrite: 512 },
		});
		assert.notEqual(truth?.usage?.input, 40);
		assert.equal(truth?.usage?.reasoning, undefined);
		assert.equal(providerTruthFromExchange({ ...recorded, upstream: "google" }), undefined);
	});
}

test("Anthropic deltas replace reported input fields and expose only explicit thinking usage", () => {
	const truth = providerTruthFromExchange(exchange("/v1/messages", sse([
		{ type: "message_start", message: anthropicMessage },
		{ type: "message_delta", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 100, output_tokens_details: { thinking_tokens: 80 } } },
	])));
	assert.deepEqual(truth?.usage, { input: 60, cached: 20, cacheWrite: 30, output: 100, reasoning: 80 });
	const missing = providerTruthFromExchange(exchange("/v1/messages", JSON.stringify({ usage: {} })));
	assert.equal(missing?.usage, undefined);
});

const geminiResponse = {
	modelVersion: "gemini-2.5-flash", responseId: "gemini-1",
	candidates: [{ finishReason: "STOP" }],
	usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 150, cachedContentTokenCount: 512 },
};

for (const format of ["json", "sse", "array", "stream-json"]) {
	test(`normalizes Gemini cached and thinking usage (${format})`, () => {
		const chunks = [
			{ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, thoughtsTokenCount: 2 } },
			{ candidates: [{ content: { parts: [{ text: "Paris" }] } }] },
			geminiResponse,
		];
		const body = format === "sse" ? sse(chunks) : JSON.stringify(format === "array" ? chunks : geminiResponse);
		const recorded = exchange(`/v1beta/models/gemini-2.5-flash:${format === "json" ? "generateContent" : "streamGenerateContent"}`, body, { upstream: "google" });
		const truth = providerTruthFromExchange(recorded);
		assert.deepEqual(truth, {
			api: "generateContent", streaming: format !== "json", model: "gemini-2.5-flash", responseId: "gemini-1", finishReason: "STOP",
			usage: { input: 1000, output: 350, cached: 512, reasoning: 150 },
		});
		assert.notEqual(truth?.usage?.output, 200);
		assert.equal(providerTruthFromExchange({ ...recorded, upstream: "openrouter" }), undefined);
	});
}

test("Gemini's last usage report replaces earlier fields without inventing missing counts", () => {
	const truth = providerTruthFromExchange(exchange("/v1beta/models/m:streamGenerateContent", sse([
		geminiResponse, { usageMetadata: { candidatesTokenCount: 7 } },
	]), { upstream: "google" }));
	assert.deepEqual(truth?.usage, { output: 7 });
});
