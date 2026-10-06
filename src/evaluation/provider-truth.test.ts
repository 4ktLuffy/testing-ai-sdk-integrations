import assert from "node:assert/strict";
import test from "node:test";
import type {
	CapturedSpan,
	Observation,
	ProbeResult,
	ProviderCallSummary,
	ProviderExchangeSummary,
} from "../assessment/types.js";
import { evaluateVariant } from "../assessment/variant-evaluation.js";
import type { ResolvedVariant } from "../assessment/matrix.js";
import { evaluateProviderTruth } from "./evaluators/provider-truth.js";
import { findingFromObservation } from "./findings.js";

const probe: ProbeResult = {
	probeId: "llm.baseline",
	status: "completed",
	callModes: ["blocking"],
	traceIds: ["trace"],
	spanIds: [],
};
const callId = "llm.baseline:blocking:0";

function callSpan(id = callId): CapturedSpan {
	return {
		span_id: `call-${id}`,
		trace_id: "trace",
		parent_span_id: "root",
		op: "test.assessment.call",
		description: id,
		start_timestamp: 1,
		timestamp: 2,
		data: { "test.probe.id": "llm.baseline", "test.call.id": id },
	};
}

function client(
	spanId: string,
	data: Record<string, unknown> = {},
	start = 1.1,
	parent = `call-${callId}`,
): CapturedSpan {
	return {
		span_id: spanId,
		trace_id: "trace",
		parent_span_id: parent,
		op: "gen_ai.chat",
		description: "chat gpt-5-nano",
		start_timestamp: start,
		timestamp: start + 0.1,
		data: {
			"gen_ai.operation.name": "chat",
			"gen_ai.request.model": "gpt-5-nano",
			"gen_ai.response.model": "gpt-5-nano-2026",
			"gen_ai.response.id": "chatcmpl-1",
			"gen_ai.response.finish_reasons": '["stop"]',
			"gen_ai.usage.input_tokens": 1200,
			"gen_ai.usage.output_tokens": 300,
			"gen_ai.usage.total_tokens": 1500,
			"gen_ai.usage.input_tokens.cached": 1024,
			"gen_ai.usage.output_tokens.reasoning": 256,
			...data,
		},
	};
}

function exchange(
	options: Partial<ProviderExchangeSummary> = {},
): ProviderExchangeSummary {
	return {
		sequence: 0,
		path: "/chat/completions",
		status: 200,
		api: "chat",
		streaming: false,
		usage: { input: 1200, output: 300, total: 1500, cached: 1024, reasoning: 256 },
		model: "gpt-5-nano-2026",
		responseId: "chatcmpl-1",
		finishReason: "stop",
		...options,
	};
}

function calls(
	...exchanges: ProviderExchangeSummary[]
): ProviderCallSummary[] {
	return [{ callId, probeId: "llm.baseline", exchanges }];
}

function evaluate(
	spans: CapturedSpan[],
	providerCalls: ProviderCallSummary[],
): Observation[] {
	return evaluateProviderTruth(probe, "variant", [callSpan(), ...spans], providerCalls);
}

function byCapability(observations: Observation[], capability: string) {
	return observations.filter((observation) => observation.capability === capability);
}

function findingIds(observations: Observation[]): string[] {
	return observations.flatMap((observation) => {
		const finding = findingFromObservation(observation);
		return finding ? [finding.findingId] : [];
	});
}

test("matching provider usage and identity are healthy", () => {
	const observations = evaluate([client("a")], calls(exchange()));
	assert.deepEqual(
		observations.map((observation) => [observation.capability, observation.state]),
		[
			["spans.provider_call", "healthy"],
			["tokens.provider.input", "healthy"],
			["tokens.provider.output", "healthy"],
			["tokens.provider.total", "healthy"],
			["tokens.provider.cached", "healthy"],
			["tokens.provider.reasoning", "healthy"],
			["model.provider.response", "healthy"],
			["response.provider.id", "healthy"],
			["response.provider.finish_reason", "healthy"],
		],
	);
	assert.deepEqual(findingIds(observations), []);
});

test("wrong input tokens produce a finding; correct input does not", () => {
	const wrong = evaluate(
		[client("a", { "gen_ai.usage.input_tokens": 176 })],
		calls(exchange()),
	);
	const input = byCapability(wrong, "tokens.provider.input")[0];
	assert.equal(input.state, "malformed");
	assert.equal(input.expected, 1200);
	assert.equal(input.actual, 176);
	assert.ok(findingIds(wrong).includes("tokens.provider.input.malformed"));
	// Negative control.
	const right = evaluate([client("a")], calls(exchange()));
	assert.equal(findingIds(right).includes("tokens.provider.input.malformed"), false);
});

test("missing cached tokens produce a finding only when the provider reported some", () => {
	const missing = evaluate(
		[client("a", { "gen_ai.usage.input_tokens.cached": undefined })],
		calls(exchange()),
	);
	assert.equal(byCapability(missing, "tokens.provider.cached")[0].state, "missing");
	assert.ok(findingIds(missing).includes("tokens.provider.cached.missing"));
	// Negative control: the provider reported zero cached tokens.
	const zero = evaluate(
		[client("a", { "gen_ai.usage.input_tokens.cached": undefined })],
		calls(exchange({ usage: { input: 1200, output: 300, total: 1500, cached: 0 } })),
	);
	assert.equal(byCapability(zero, "tokens.provider.cached")[0].state, "healthy");
	assert.deepEqual(findingIds(zero), []);
});

test("unreported provider fields produce no observation", () => {
	const observations = evaluate(
		[client("a", { "gen_ai.usage.input_tokens.cached": undefined, "gen_ai.response.finish_reasons": undefined })],
		calls(exchange({ usage: { input: 1200, output: 300 }, finishReason: undefined })),
	);
	for (const capability of [
		"tokens.provider.total",
		"tokens.provider.cached",
		"tokens.provider.cache_write",
		"tokens.provider.reasoning",
		"response.provider.finish_reason",
	]) {
		assert.deepEqual(byCapability(observations, capability), [], capability);
	}
	assert.deepEqual(findingIds(observations), []);
});

test("reads deprecated usage aliases when the modern key is absent", () => {
	const observations = evaluate(
		[
			client("a", {
				"gen_ai.usage.input_tokens": undefined,
				"gen_ai.usage.prompt_tokens": 1200,
			}),
		],
		calls(exchange()),
	);
	const input = byCapability(observations, "tokens.provider.input")[0];
	assert.equal(input.state, "healthy");
	assert.equal(input.evidence[0].attribute, "gen_ai.usage.prompt_tokens");
});

test("absent input tokens are blocked because span presence checks own them", () => {
	const observations = evaluate(
		[client("a", { "gen_ai.usage.input_tokens": undefined })],
		calls(exchange()),
	);
	assert.equal(byCapability(observations, "tokens.provider.input")[0].state, "blocked");
	assert.equal(findingIds(observations).some((id) => id.startsWith("tokens.provider.input")), false);
});

test("a lost client span is reported; one span per exchange is healthy", () => {
	const lost = evaluate(
		[client("a")],
		calls(exchange(), exchange({ sequence: 1, responseId: "chatcmpl-2" })),
	);
	const call = byCapability(lost, "spans.provider_call")[0];
	assert.equal(call.state, "missing");
	assert.deepEqual(call.actual, { callId, clientSpans: 1, providerExchanges: 2 });
	assert.ok(findingIds(lost).includes("spans.provider_call.missing"));
	// The surviving span is matched by response ID, not by position.
	assert.equal(byCapability(lost, "response.provider.id")[0].state, "healthy");
	// Negative control.
	const healthy = evaluate([client("a")], calls(exchange()));
	assert.equal(byCapability(healthy, "spans.provider_call")[0].state, "healthy");
});

test("a duplicate client span is reported", () => {
	const duplicate = evaluate([client("a"), client("b", {}, 1.2)], calls(exchange()));
	const call = byCapability(duplicate, "spans.provider_call")[0];
	assert.equal(call.state, "malformed");
	assert.deepEqual(call.actual, {
		callId,
		clientSpans: 2,
		providerExchanges: 1,
		duplicateResponseIds: ["chatcmpl-1"],
	});
	assert.ok(findingIds(duplicate).includes("spans.provider_call.malformed"));
});

test("matches exchanges to spans by response ID before start order", () => {
	const observations = evaluate(
		[
			client("first", { "gen_ai.response.id": "chatcmpl-2", "gen_ai.usage.input_tokens": 7 }, 1.1),
			client("second", { "gen_ai.response.id": "chatcmpl-1" }, 1.2),
		],
		calls(
			exchange({ sequence: 0, responseId: "chatcmpl-1" }),
			exchange({
				sequence: 1,
				responseId: "chatcmpl-2",
				usage: { input: 7, output: 300, total: 307, cached: 1024, reasoning: 256 },
			}),
		),
	);
	const input = byCapability(observations, "tokens.provider.input");
	assert.deepEqual(
		input.map((observation) => [observation.evidence[0].spanId, observation.state]),
		[
			["second", "healthy"],
			["first", "healthy"],
		],
	);
});

test("ignores failed exchanges and calls without a client span", () => {
	assert.deepEqual(evaluate([client("a")], calls(exchange({ status: 429 }))), []);
	const noClient = evaluate([], calls(exchange()));
	assert.deepEqual(
		noClient.map((observation) => [observation.capability, observation.state]),
		[["spans.provider_call", "blocked"]],
	);
});

const variant: ResolvedVariant = {
	id: "node/llm/openai/variant",
	targetId: "node/llm/openai",
	identity: { frameworkVersion: "7", sentryVersion: "11", options: {} },
	modelOverrides: {},
};

test("variant evaluation runs provider truth only when calls were recorded", () => {
	const spans = [
		{
			span_id: "root",
			trace_id: "trace",
			op: "test.assessment",
			start_timestamp: 0,
			timestamp: 3,
			data: { "test.probe.id": "llm.baseline" },
		},
		callSpan(),
		client("a", { "gen_ai.usage.input_tokens": 99 }),
	];
	const base = {
		variant,
		category: "llm" as const,
		probes: [probe],
		spans,
		runtimeFailures: [],
	};
	const without = evaluateVariant(base);
	assert.equal(
		without.observations.some((observation) => observation.capability.includes(".provider")),
		false,
	);
	assert.equal(without.providerCalls, undefined);
	const recorded = evaluateVariant({ ...base, providerCalls: calls(exchange()) });
	assert.ok(
		recorded.findings.some((finding) => finding.findingId === "tokens.provider.input.malformed"),
	);
	assert.equal(recorded.providerCalls?.length, 1);
});

test("variant evaluation never applies provider truth to expected provider errors", () => {
	const errorProbe: ProbeResult = { ...probe, probeId: "llm.provider_error" };
	const errorCallId = "llm.provider_error:blocking:0";
	const result = evaluateVariant({
		variant,
		category: "llm",
		probes: [errorProbe],
		spans: [
			{
				span_id: "root",
				trace_id: "trace",
				op: "test.assessment",
				start_timestamp: 0,
				timestamp: 3,
				data: { "test.probe.id": "llm.provider_error" },
			},
			callSpan(errorCallId),
			client("a", { "gen_ai.usage.input_tokens": 99 }, 1.1, `call-${errorCallId}`),
		],
		runtimeFailures: [],
		providerCalls: [
			{ callId: errorCallId, probeId: "llm.provider_error", exchanges: [exchange()] },
		],
	});
	assert.equal(
		result.observations.some((observation) => observation.capability.includes(".provider")),
		false,
	);
});
