import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentRunLog,
	CapturedSpan,
	ProbeResult,
	ProviderCallSummary,
	ProviderExchangeSummary,
} from "../assessment/types.js";
import { getProbeInputs, type AgentProbeInput } from "../probes/inputs.js";
import {
	evaluateDetectability,
	observedFailures,
} from "./evaluators/detectability.js";
import { findingFromObservation } from "./findings.js";

const inputs = getProbeInputs("agents") as Record<string, AgentProbeInput>;

function probe(probeId: string): ProbeResult {
	return { probeId, status: "completed", callModes: ["blocking"], traceIds: [], spanIds: [] };
}

let nextStart = 1;
function span(
	op: string,
	spanId: string,
	parent: string,
	data: Record<string, unknown> = {},
	extra: Partial<CapturedSpan> = {},
): CapturedSpan {
	const start = nextStart++;
	return {
		op,
		span_id: spanId,
		parent_span_id: parent,
		trace_id: "t",
		start_timestamp: start,
		timestamp: start + 0.5,
		description: op,
		status: "ok",
		data,
		...extra,
	};
}

function callSpan(callId: string): CapturedSpan {
	return {
		op: "test.assessment.call",
		span_id: `call-${callId}`,
		trace_id: "t",
		start_timestamp: 0,
		timestamp: 100,
		description: callId,
		data: { "test.call.id": callId },
	};
}

function exchanges(...entries: Array<Partial<ProviderExchangeSummary>>): ProviderExchangeSummary[] {
	return entries.map((entry, index) => ({ sequence: index, path: "/chat/completions", status: 200, ...entry }));
}

function evaluate(
	probeId: string,
	spans: CapturedSpan[],
	log: Omit<AgentRunLog, "probeId" | "callId">,
	exchangeList: ProviderExchangeSummary[],
) {
	const callId = `${probeId}:blocking:0`;
	const call: ProviderCallSummary = { callId, probeId, exchanges: exchangeList };
	return evaluateDetectability(
		probe(probeId),
		"variant",
		[callSpan(callId), ...spans],
		inputs[probeId],
		[{ probeId, callId, ...log }],
		[call],
	);
}

function verdicts(result: ReturnType<typeof evaluate>): Record<string, string> {
	return Object.fromEntries(result.results.map((entry) => [entry.failureClass, entry.verdict]));
}

const parent = "call-agent.fault.";

test("ground truth comes from the program log and provider exchanges", () => {
	const log: AgentRunLog = {
		probeId: "agent.fault.tool_loop",
		callId: "c",
		tools: [0, 1, 2].map(() => ({ name: "search_docs", arguments: '{"query": "refund policy"}' })),
		error: { type: "MaxTurnsExceeded", message: "", stepLimit: true },
	};
	const observed = observedFailures(log, { callId: "c", probeId: "p", exchanges: exchanges({}, {}, {}) }, inputs["agent.fault.tool_loop"]);
	assert.deepEqual([...observed.keys()].sort(), ["dead_end", "tool_loop"]);

	const varied = { ...log, tools: log.tools.map((tool, index) => ({ ...tool, arguments: `{"query": "q${index}"}` })) };
	assert.ok(!observedFailures(varied, undefined, undefined).has("tool_loop"));

	const storm = { callId: "c", probeId: "p", exchanges: exchanges({ status: 500, injectedFault: "provider_500x3" }, { status: 500, injectedFault: "provider_500x3" }, { status: 500, injectedFault: "provider_500x3" }, {}) };
	assert.ok(observedFailures({ ...log, tools: [], error: undefined, answer: "Paris." }, storm, undefined).has("retry_storm"));
	const realRateLimits = { callId: "c", probeId: "p", exchanges: exchanges({ status: 429 }, {}, { status: 429 }, {}) };
	assert.ok(!observedFailures({ ...log, tools: [], error: undefined, answer: "Paris." }, realRateLimits, undefined).has("retry_storm"));

	const errorInput = inputs["agent.fault.silent_tool_error"];
	const called = [{ name: "lookup_order", arguments: '{"order_id": "A-1042"}' }];
	assert.ok(observedFailures({ ...log, tools: called, error: undefined, answer: "Order A-1042 shipped." }, undefined, errorInput).has("silent_tool_error"));
	assert.ok(!observedFailures({ ...log, tools: called, error: undefined, answer: "Sorry, the lookup failed." }, undefined, errorInput).has("silent_tool_error"));

	const truncated = { callId: "c", probeId: "p", exchanges: exchanges({ path: "/responses", incompleteReason: "max_output_tokens" }) };
	assert.ok(observedFailures({ ...log, tools: [], error: undefined }, truncated, undefined).has("truncated_answer"));

	const empty = { callId: "c", probeId: "p", exchanges: exchanges({ toolCalls: true }, { finishReason: "stop" }) };
	const emptyRun = observedFailures({ ...log, tools: called, error: undefined, answer: "" }, empty, undefined);
	assert.ok(emptyRun.has("empty_answer"));
	assert.ok(!emptyRun.has("dead_end"));
	const stillCalling = { callId: "c", probeId: "p", exchanges: exchanges({ toolCalls: true }, { toolCalls: true }) };
	assert.ok(observedFailures({ ...log, tools: called, error: undefined, answer: "" }, stillCalling, undefined).has("dead_end"));
});

test("healthy control run raises no detection (negative control)", () => {
	const p = `${parent}control:blocking:0`;
	const result = evaluate(
		"agent.fault.control",
		[
			span("gen_ai.invoke_agent", "ag", p, { "gen_ai.agent.name": "a" }),
			span("gen_ai.chat", "c1", "ag", { "gen_ai.response.finish_reasons": '["tool_calls"]' }),
			span("gen_ai.execute_tool", "t1", "ag", { "gen_ai.tool.name": "lookup_order", "gen_ai.tool.call.arguments": '{"order_id":"A-1042"}', "gen_ai.tool.call.result": "Order A-1042: shipped on Oct 3, arriving Oct 7." }),
			span("gen_ai.chat", "c2", "ag", { "gen_ai.response.finish_reasons": '["stop"]', "gen_ai.response.text": "It shipped on Oct 3." }),
		],
		{ tools: [{ name: "lookup_order", arguments: '{"order_id": "A-1042"}' }], answer: "It shipped on Oct 3." },
		exchanges({ toolCalls: true, finishReason: "tool_calls" }, { finishReason: "stop" }),
	);
	assert.deepEqual(verdicts(result), { control: "not_applicable" });
	assert.equal(result.observations[0].state, "healthy");
	assert.equal(result.observations.map(findingFromObservation).filter(Boolean).length, 0);
});

test("a truncated answer is detectable with a finish reason and undetectable without one", () => {
	const p = `${parent}truncated_answer:blocking:0`;
	const run = (data: Record<string, unknown>) =>
		evaluate(
			"agent.fault.truncated_answer",
			[span("gen_ai.invoke_agent", "ag", p), span("gen_ai.chat", "c1", "ag", data)],
			{ tools: [], error: { type: "ModelBehaviorError", message: "incomplete" } },
			exchanges({ path: "/responses", incompleteReason: "max_output_tokens" }),
		);
	assert.equal(verdicts(run({ "gen_ai.response.finish_reasons": '["length"]' })).truncated_answer, "detectable");
	const missing = run({});
	assert.equal(verdicts(missing).truncated_answer, "undetectable");
	const reasons = missing.results[0].reasons.map((reason) => reason.id);
	assert.deepEqual(reasons, ["finish_reason.missing"]);
	const finding = findingFromObservation(missing.observations[0]);
	assert.equal(finding?.findingId, "detect.truncated_answer.undetectable");
	assert.equal(finding?.severity, "major");
});

test("a tool loop without recorded arguments names the missing attribute", () => {
	const p = `${parent}tool_loop:blocking:0`;
	const tools = [0, 1, 2].map((index) =>
		span("gen_ai.execute_tool", `t${index}`, "ag", { "gen_ai.tool.name": "search_docs" }),
	);
	const result = evaluate(
		"agent.fault.tool_loop",
		[span("gen_ai.invoke_agent", "ag", p), ...tools, span("gen_ai.chat", "c", "ag", { "gen_ai.response.finish_reasons": '["stop"]', "gen_ai.response.text": "Refunds within 30 days." })],
		{ tools: [0, 1, 2].map(() => ({ name: "search_docs", arguments: '{"query": "refund policy"}' })), answer: "Refunds within 30 days.", sendDefaultPii: false },
		exchanges({}, {}, {}, {}),
	);
	const loop = result.results.find((entry) => entry.failureClass === "tool_loop");
	assert.equal(loop?.verdict, "undetectable");
	assert.equal(loop?.reasons[0].id, "tool.arguments_missing");
	assert.match(loop?.reasons[0].detail ?? "", /send_default_pii off/);
});

test("a retry storm needs provider http.client spans", () => {
	const p = `${parent}retry_storm:blocking:0`;
	const storm = exchanges(
		{ status: 500, injectedFault: "provider_500x3" },
		{ status: 500, injectedFault: "provider_500x3" },
		{ status: 500, injectedFault: "provider_500x3" },
		{ finishReason: "stop" },
	);
	const http = (id: string, code: number) =>
		span("http.client", id, p, { "http.response.status_code": code }, { description: "POST http://127.0.0.1/provider/1/openrouter/chat/completions" });
	const chat = span("gen_ai.chat", "c", p, { "gen_ai.response.finish_reasons": '["stop"]', "gen_ai.response.text": "Paris." });
	const visible = evaluate("agent.fault.retry_storm", [http("h1", 500), http("h2", 500), http("h3", 500), http("h4", 200), chat], { tools: [], answer: "Paris." }, storm);
	assert.equal(verdicts(visible).retry_storm, "detectable");
	const hidden = evaluate("agent.fault.retry_storm", [chat], { tools: [], answer: "Paris." }, storm);
	assert.equal(verdicts(hidden).retry_storm, "undetectable");
	assert.equal(hidden.results[0].reasons[0].id, "http.span_missing");
});

test("a detection on a class the run did not exhibit is a false alarm", () => {
	const p = `${parent}dead_end:blocking:0`;
	const result = evaluate(
		"agent.fault.dead_end",
		[
			span("gen_ai.invoke_agent", "ag", p),
			span("gen_ai.execute_tool", "t", "ag", { "gen_ai.tool.name": "search_docs", "gen_ai.tool.call.arguments": "{}", "gen_ai.tool.call.result": "Partial results only." }),
			span("gen_ai.chat", "c", "ag", { "gen_ai.response.finish_reasons": '["tool_calls"]', "gen_ai.response.text": "Refunds are accepted within 30 days." }),
		],
		{ tools: [{ name: "search_docs", arguments: "{}" }], answer: "Refunds are accepted within 30 days." },
		exchanges({ toolCalls: true }, { finishReason: "stop" }),
	);
	assert.equal(verdicts(result).dead_end, "false_alarm");
	assert.equal(findingFromObservation(result.observations[0])?.findingId, "detect.dead_end.false_alarm");
});

test("a silent tool error that did not happen reports the data that would be needed", () => {
	const p = `${parent}silent_tool_error:blocking:0`;
	const result = evaluate(
		"agent.fault.silent_tool_error",
		[
			span("gen_ai.invoke_agent", "ag", p),
			span("gen_ai.execute_tool", "t", "ag", { "gen_ai.tool.name": "lookup_order" }),
			span("gen_ai.chat", "c", "ag", { "gen_ai.response.finish_reasons": '["stop"]' }),
		],
		{ tools: [{ name: "lookup_order", arguments: '{"order_id": "A-1042"}' }], answer: "Sorry, the lookup failed." },
		exchanges({ finishReason: "stop" }),
	);
	const silent = result.results.find((entry) => entry.failureClass === "silent_tool_error");
	assert.equal(silent?.verdict, "not_triggered");
	assert.equal(silent?.label, "acknowledged");
	assert.deepEqual(silent?.reasons.map((reason) => reason.id), ["tool.result_missing", "answer.missing"]);
	assert.equal(findingFromObservation(result.observations[0]), undefined);
});
