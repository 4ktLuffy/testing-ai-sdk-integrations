import assert from "node:assert/strict";
import test from "node:test";
import type { CapturedSpan } from "../assessment/types.js";
import { detectTrace, stableJson } from "./detectors.js";

/** Ported from SpanProof's tests/test_detectors.py, hard negatives included. */
function span(
	op: string,
	spanId: string,
	options: {
		parent?: string | null;
		start?: number;
		status?: string;
		description?: string;
		data?: Record<string, unknown>;
	} = {},
): CapturedSpan {
	return {
		op,
		span_id: spanId,
		parent_span_id: options.parent === null ? undefined : (options.parent ?? "ag"),
		trace_id: "t",
		status: options.status ?? "ok",
		start_timestamp: options.start ?? 1,
		timestamp: (options.start ?? 1) + 0.1,
		description: options.description ?? op,
		data: options.data ?? {},
	};
}

const agent = span("gen_ai.invoke_agent", "ag", {
	parent: null,
	start: 0,
	data: { "gen_ai.agent.name": "a" },
});

function kinds(spans: CapturedSpan[]): Set<string> {
	return new Set(detectTrace(spans).map((detection) => detection.kind));
}

function tool(
	spanId: string,
	start: number,
	options: { name?: string; args?: unknown; out?: string; parent?: string } = {},
): CapturedSpan {
	return span("gen_ai.execute_tool", spanId, {
		start,
		parent: options.parent,
		data: {
			"gen_ai.tool.name": options.name ?? "search",
			"gen_ai.tool.call.arguments": JSON.stringify(options.args ?? {}),
			"gen_ai.tool.call.result": options.out ?? "ok",
		},
	});
}

function chat(
	spanId: string,
	start: number,
	options: { finish?: string; text?: string; extra?: Record<string, unknown> } = {},
): CapturedSpan {
	return span("gen_ai.chat", spanId, {
		start,
		data: {
			"gen_ai.response.finish_reasons": JSON.stringify([options.finish ?? "stop"]),
			"gen_ai.response.text": options.text ?? "done",
			...options.extra,
		},
	});
}

function http(spanId: string, start: number, code: number, path = "/v1/chat/completions") {
	return span("http.client", spanId, {
		start,
		description: `POST http://h${path}`,
		data: { "http.response.status_code": code },
	});
}

test("healthy agent run with tools raises no detection (negative control)", () => {
	const healthy = [
		agent,
		http("h1", 0.5, 200),
		chat("c1", 0.5, { finish: "tool_calls", text: "" }),
		tool("t1", 1, { name: "lookup_order", args: { order_id: "A-1042" }, out: "Order A-1042: shipped on Oct 3." }),
		http("h2", 1.5, 200),
		chat("c2", 2, { text: '["Order A-1042 shipped on Oct 3 and arrives Oct 7."]' }),
	];
	assert.deepEqual(kinds(healthy), new Set());
});

test("tool loop fires on identical arguments, not on pagination", () => {
	const loop = [agent, ...[0, 1, 2].map((i) => tool(`t${i}`, i, { args: { q: "x" } })), chat("c", 9)];
	const pages = [
		agent,
		...[0, 1, 2, 3].map((i) => tool(`t${i}`, i, { args: { q: "x", page: i } })),
		chat("c", 9),
	];
	assert.ok(kinds(loop).has("tool_loop"));
	assert.ok(!kinds(pages).has("tool_loop"));
});

test("tool loop does not guess when arguments are not recorded", () => {
	const noArgs = [0, 1, 2].map((i) => {
		const value = tool(`t${i}`, i);
		delete value.data?.["gen_ai.tool.call.arguments"];
		return value;
	});
	assert.ok(!kinds([agent, ...noArgs, chat("c", 9)]).has("tool_loop"));
});

test("tool loop uses argument order-insensitive comparison", () => {
	const loop = [
		agent,
		tool("t0", 0, { args: { a: 1, b: 2 } }),
		tool("t1", 1, { args: { b: 2, a: 1 } }),
		tool("t2", 2, { args: { a: 1, b: 2 } }),
		chat("c", 9),
	];
	assert.ok(kinds(loop).has("tool_loop"));
	assert.equal(stableJson({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}');
});

test("loops are counted per agent scope", () => {
	const inner = span("gen_ai.invoke_agent", "in", { parent: "ag", start: 5, data: { "gen_ai.agent.name": "worker" } });
	const outerCalls = [0, 1].map((i) => tool(`o${i}`, i, { args: { sku: "A" } }));
	const innerCalls = [0, 1].map((i) => tool(`i${i}`, 6 + i, { args: { sku: "A" }, parent: "in" }));
	assert.ok(!kinds([agent, inner, ...outerCalls, ...innerCalls, chat("c", 9)]).has("tool_loop"));
});

test("silent tool error fires on an error payload, not on benign text", () => {
	const bad = [agent, tool("t", 1, { out: '{"error": "upstream 503"}' }), chat("c", 2)];
	const benign = [agent, tool("t", 1, { out: "No errors found in the last 24h" }), chat("c", 2)];
	assert.ok(kinds(bad).has("silent_tool_error"));
	assert.ok(!kinds(benign).has("silent_tool_error"));
});

test("silent tool error requires the run to continue", () => {
	const aborted = [{ ...agent, status: "internal_error" }, tool("t", 1, { out: '{"error": "x"}' }), chat("c", 2)];
	assert.ok(!kinds(aborted).has("silent_tool_error"));
});

test("silent tool error needs the answer text", () => {
	const final = chat("c", 2);
	delete final.data?.["gen_ai.response.text"];
	assert.ok(!kinds([agent, tool("t", 1, { out: '{"ok": false, "error": "x"}' }), final]).has("silent_tool_error"));
});

test("exception-style tool output is an error", () => {
	const bad = [agent, tool("t", 1, { out: "RuntimeError: inventory database disconnected" }), chat("c", 2, { text: "All good." })];
	assert.ok(kinds(bad).has("silent_tool_error"));
});

test("an acknowledged failure is not silent", () => {
	const failed = tool("t", 1, { out: "TimeoutError: inventory service did not respond" });
	const ok = [agent, failed, chat("c", 2, { text: '["The lookup timed out, so I cannot confirm availability."]' })];
	assert.ok(!kinds(ok).has("silent_tool_error"));
});

test("structured error payload anywhere in the object", () => {
	const out = '{"ok":false,"error":{"code":"ACCESS_DENIED","message":"Cannot read audit record"}}';
	assert.ok(kinds([agent, tool("t", 1, { out }), chat("c", 2, { text: '["Verified: approved."]' })]).has("silent_tool_error"));
	const fine = [agent, tool("t", 1, { out: '{"ok": true, "error": null, "items": 3}' }), chat("c", 2)];
	assert.ok(!kinds(fine).has("silent_tool_error"));
});

test("an error status on the tool span is a failure", () => {
	const errored = { ...tool("t", 1, { out: "" }), status: "error" };
	assert.ok(kinds([agent, errored, chat("c", 2, { text: "Here you go." })]).has("silent_tool_error"));
});

test("retry storm needs three consecutive failures", () => {
	const storm = [agent, http("h1", 1, 500), http("h2", 2, 500), http("h3", 3, 503), http("h4", 4, 200), chat("c", 5)];
	const one = [agent, http("h1", 1, 500), http("h2", 2, 200), chat("c", 3)];
	const broken = [agent, http("h1", 1, 500), http("h2", 2, 200), http("h3", 3, 500), http("h4", 4, 500), chat("c", 5)];
	assert.ok(kinds(storm).has("retry_storm"));
	assert.ok(!kinds(one).has("retry_storm"));
	assert.ok(!kinds(broken).has("retry_storm"));
});

test("lost LLM span counts only successful provider paths", () => {
	assert.ok(kinds([agent, http("h1", 1, 200), http("h2", 2, 200), chat("c", 3)]).has("lost_llm_span"));
	assert.ok(!kinds([agent, http("h1", 1, 200), chat("c", 3)]).has("lost_llm_span"));
	assert.ok(!kinds([agent, http("h1", 1, 200, "/api/users"), chat("c", 3)]).has("lost_llm_span"));
	assert.ok(!kinds([agent, http("h1", 1, 200, "/v1/responses"), chat("c", 3)]).has("lost_llm_span"));
});

test("dead end, truncated answer, and empty answer", () => {
	assert.ok(kinds([agent, tool("t", 1), chat("c", 0.5, { finish: "tool_calls" })]).has("dead_end"));
	assert.ok(kinds([agent, chat("c", 1, { finish: "length", text: "The weather is" })]).has("truncated_answer"));
	assert.ok(kinds([agent, chat("c", 1, { text: '[""]' })]).has("empty_answer"));
	assert.deepEqual(kinds([agent, chat("c", 1, { text: "A long and complete answer." })]), new Set());
});

test("dead end from a failed agent span whose last tool follows the last model call", () => {
	const failedAgent = { ...agent, status: "internal_error" };
	assert.ok(kinds([failedAgent, chat("c", 0.5, { finish: "" }), tool("t", 1)]).has("dead_end"));
	assert.ok(!kinds([agent, chat("c", 0.5, { finish: "" }), tool("t", 1)]).has("dead_end"));
});

test("finish reasons in Python repr and bare strings are parsed", () => {
	const repr = chat("c", 1);
	(repr.data as Record<string, unknown>)["gen_ai.response.finish_reasons"] = "['length']";
	assert.ok(kinds([agent, repr]).has("truncated_answer"));
	const bare = chat("c", 1);
	(bare.data as Record<string, unknown>)["gen_ai.response.finish_reasons"] = "length";
	assert.ok(kinds([agent, bare]).has("truncated_answer"));
	const array = chat("c", 1);
	(array.data as Record<string, unknown>)["gen_ai.response.finish_reasons"] = ["LENGTH"];
	assert.ok(kinds([agent, array]).has("truncated_answer"));
});

test("whitespace-only answer is empty; a missing answer is unknown", () => {
	assert.ok(kinds([agent, chat("c", 1, { text: '[" \\n\\t "]' })]).has("empty_answer"));
	const missing = chat("c", 1);
	delete missing.data?.["gen_ai.response.text"];
	assert.ok(!kinds([agent, missing]).has("empty_answer"));
});

test("without an agent span the whole trace is one run", () => {
	const loop = [0, 1, 2].map((i) => tool(`t${i}`, i, { args: { q: "x" }, parent: "root" }));
	assert.ok(kinds([...loop, { ...chat("c", 9), parent_span_id: "root" }]).has("tool_loop"));
});

test("provider HTTP spans are recognized by url.full when the name has only the host", () => {
	const nodeStyle = (spanId: string, start: number, code: number) =>
		span("http.client", spanId, {
			start,
			description: "POST api.example.com",
			data: { "http.response.status_code": code, "url.full": "https://api.example.com/v1/chat/completions" },
		});
	const storm = [agent, nodeStyle("h1", 1, 500), nodeStyle("h2", 2, 500), nodeStyle("h3", 3, 500), nodeStyle("h4", 4, 200), chat("c", 5)];
	assert.ok(kinds(storm).has("retry_storm"));
	const otherPath = span("http.client", "h9", {
		start: 1,
		description: "POST api.example.com",
		data: { "http.response.status_code": 500, "url.full": "https://api.example.com/v1/users" },
	});
	assert.ok(!kinds([agent, otherPath, { ...otherPath, span_id: "h8" }, { ...otherPath, span_id: "h7" }, chat("c", 5)]).has("retry_storm"));
});

test("a Vercel AI SDK tool-result envelope is unwrapped before error checks", () => {
	const envelope = (output: unknown) =>
		JSON.stringify({ type: "tool-result", toolCallId: "c1", toolName: "lookup", input: {}, output });
	const failed = [agent, tool("t", 1, { out: envelope('{"ok":false,"error":"upstream 503"}') }), chat("c", 2, { text: "Your order shipped." })];
	assert.ok(kinds(failed).has("silent_tool_error"));
	const fine = [agent, tool("t", 1, { out: envelope("Order A-1042: shipped") }), chat("c", 2, { text: "Your order shipped." })];
	assert.ok(!kinds(fine).has("silent_tool_error"));
});
