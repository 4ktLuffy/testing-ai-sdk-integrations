import type {
	CapturedSpan,
	Evidence,
	Observation,
	ProbeResult,
	ProviderCallSummary,
	ProviderExchangeSummary,
	ProviderUsage,
} from "../../assessment/types.js";
import { assessmentCallId, callAncestor, spanKey } from "./spans.js";
import { evidence, isClientSpan, parseJson } from "./telemetry-shared.js";

type UsageField = keyof ProviderUsage;

/**
 * Span attributes for each usage meaning: the sentry-conventions key first,
 * then deprecated aliases (same table as SpanProof's conventions.USAGE_KEYS).
 */
const usageAttributes: Record<UsageField, readonly string[]> = {
	input: ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"],
	output: ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens"],
	total: ["gen_ai.usage.total_tokens"],
	cached: [
		"gen_ai.usage.cache_read.input_tokens",
		"gen_ai.usage.input_tokens.cached",
		"gen_ai.usage.cache_read_input_tokens",
	],
	cacheWrite: [
		"gen_ai.usage.cache_creation.input_tokens",
		"gen_ai.usage.input_tokens.cache_write",
		"gen_ai.usage.cache_creation_input_tokens",
	],
	reasoning: [
		"gen_ai.usage.reasoning.output_tokens",
		"gen_ai.usage.output_tokens.reasoning",
	],
};

const usageCapabilities: Record<UsageField, string> = {
	input: "tokens.provider.input",
	output: "tokens.provider.output",
	total: "tokens.provider.total",
	cached: "tokens.provider.cached",
	cacheWrite: "tokens.provider.cache_write",
	reasoning: "tokens.provider.reasoning",
};

/**
 * Presence of these values is already evaluated from spans alone
 * (tokens.input, tokens.output, tokens.total, model.response). When the span
 * has no value, the provider-truth observation is blocked instead of
 * repeating that finding.
 */
const presenceEvaluated = new Set<UsageField>(["input", "output", "total"]);

const finishReasonAttributes = [
	"gen_ai.response.finish_reasons",
	"gen_ai.response.finish_reason",
	"ai.finish_reason",
];

function firstAttribute(
	span: CapturedSpan,
	attributes: readonly string[],
): { attribute: string; value: unknown } | undefined {
	for (const attribute of attributes) {
		const value = span.data?.[attribute];
		if (value !== undefined && value !== null) return { attribute, value };
	}
	return undefined;
}

function stringAttribute(span: CapturedSpan, attribute: string) {
	const value = span.data?.[attribute];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finishReasons(value: unknown): string[] {
	const parsed =
		typeof value === "string" && value.trim().startsWith("[")
			? parseJson(value)
			: value;
	const values = Array.isArray(parsed) ? parsed : [parsed];
	return values
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.toLowerCase());
}

function exchangeEvidence(
	exchange: ProviderExchangeSummary,
	field: string,
	value: unknown,
): Evidence {
	return {
		attribute: `provider.${field}`,
		value,
		description: `Provider exchange ${exchange.sequence}: ${exchange.path} (HTTP ${exchange.status}${exchange.terminalEvent ? `, ${exchange.terminalEvent}` : ""})`,
	};
}

function compared(
	capability: string,
	state: Observation["state"],
	probe: ProbeResult,
	variantId: string,
	span: CapturedSpan,
	exchange: ProviderExchangeSummary,
	field: string,
	expected: unknown,
	attribute: string,
	actual: unknown,
): Observation {
	return {
		observationId: `${capability}:${span.span_id}`,
		capability,
		state,
		probeId: probe.probeId,
		variantId,
		expected,
		actual,
		evidence: [
			...evidence(span, attribute, actual),
			exchangeEvidence(exchange, field, expected),
		],
	};
}

function usageObservations(
	probe: ProbeResult,
	variantId: string,
	span: CapturedSpan,
	exchange: ProviderExchangeSummary,
): Observation[] {
	const usage = exchange.usage ?? {};
	return (Object.keys(usageAttributes) as UsageField[]).flatMap((field) => {
		const expected = usage[field];
		// Unreported provider fields are never checked.
		if (expected === undefined) return [];
		const capability = usageCapabilities[field];
		const found = firstAttribute(span, usageAttributes[field]);
		let state: Observation["state"];
		if (!found) {
			if (presenceEvaluated.has(field)) state = "blocked";
			else state = expected > 0 ? "missing" : "healthy";
		} else {
			state = found.value === expected ? "healthy" : "malformed";
		}
		return [
			compared(
				capability,
				state,
				probe,
				variantId,
				span,
				exchange,
				`usage.${field}`,
				expected,
				found?.attribute ?? usageAttributes[field][0],
				found?.value,
			),
		];
	});
}

function identityObservations(
	probe: ProbeResult,
	variantId: string,
	span: CapturedSpan,
	exchange: ProviderExchangeSummary,
): Observation[] {
	const observations: Observation[] = [];
	if (exchange.model !== undefined) {
		const actual = stringAttribute(span, "gen_ai.response.model");
		let state: Observation["state"] = "blocked";
		if (actual !== undefined) {
			state = actual === exchange.model ? "healthy" : "malformed";
		}
		observations.push(
			compared(
				"model.provider.response",
				state,
				probe,
				variantId,
				span,
				exchange,
				"model",
				exchange.model,
				"gen_ai.response.model",
				actual,
			),
		);
	}
	if (exchange.responseId !== undefined) {
		const actual = stringAttribute(span, "gen_ai.response.id");
		let state: Observation["state"] = "missing";
		if (actual !== undefined) {
			state = actual === exchange.responseId ? "healthy" : "malformed";
		}
		observations.push(
			compared(
				"response.provider.id",
				state,
				probe,
				variantId,
				span,
				exchange,
				"id",
				exchange.responseId,
				"gen_ai.response.id",
				actual,
			),
		);
	}
	if (exchange.finishReason !== undefined) {
		const found = firstAttribute(span, finishReasonAttributes);
		const reasons = found ? finishReasons(found.value) : [];
		let state: Observation["state"] = "missing";
		if (reasons.length > 0) {
			state = reasons.includes(exchange.finishReason.toLowerCase())
				? "healthy"
				: "malformed";
		}
		observations.push(
			compared(
				"response.provider.finish_reason",
				state,
				probe,
				variantId,
				span,
				exchange,
				"finish_reason",
				exchange.finishReason,
				found?.attribute ?? finishReasonAttributes[0],
				found?.value,
			),
		);
	}
	return observations;
}

/** Pair exchanges with client spans: by response ID first, then start order. */
function matchExchanges(
	exchanges: readonly ProviderExchangeSummary[],
	clients: readonly CapturedSpan[],
): Array<[ProviderExchangeSummary, CapturedSpan]> {
	const remaining = [...clients].sort(
		(left, right) => left.start_timestamp - right.start_timestamp,
	);
	const pairs: Array<[ProviderExchangeSummary, CapturedSpan]> = [];
	const unmatched: ProviderExchangeSummary[] = [];
	for (const exchange of exchanges) {
		const index = exchange.responseId
			? remaining.findIndex(
					(span) =>
						stringAttribute(span, "gen_ai.response.id") === exchange.responseId,
				)
			: -1;
		if (index === -1) {
			unmatched.push(exchange);
			continue;
		}
		pairs.push([exchange, remaining[index]]);
		remaining.splice(index, 1);
	}
	for (const exchange of unmatched) {
		const span = remaining.shift();
		if (!span) break;
		pairs.push([exchange, span]);
	}
	return pairs.sort((left, right) => left[0].sequence - right[0].sequence);
}

function duplicateResponseIds(clients: readonly CapturedSpan[]): string[] {
	const counts = new Map<string, number>();
	for (const span of clients) {
		const id = stringAttribute(span, "gen_ai.response.id");
		if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id]) => id);
}

function providerCallObservation(
	probe: ProbeResult,
	variantId: string,
	callId: string,
	exchanges: readonly ProviderExchangeSummary[],
	clients: readonly CapturedSpan[],
): Observation {
	const duplicates = duplicateResponseIds(clients);
	let state: Observation["state"] = "healthy";
	// A call without any client span is already reported by spans.client.
	if (clients.length === 0) state = "blocked";
	else if (clients.length < exchanges.length) state = "missing";
	else if (clients.length > exchanges.length || duplicates.length > 0) {
		state = "malformed";
	}
	return {
		observationId: `spans.provider_call:${callId}`,
		capability: "spans.provider_call",
		state,
		probeId: probe.probeId,
		variantId,
		expected: { callId, clientSpans: exchanges.length },
		actual: {
			callId,
			clientSpans: clients.length,
			providerExchanges: exchanges.length,
			...(duplicates.length > 0 ? { duplicateResponseIds: duplicates } : {}),
		},
		evidence: [
			...clients.flatMap((span) =>
				evidence(
					span,
					"gen_ai.response.id",
					stringAttribute(span, "gen_ai.response.id"),
				),
			),
			...exchanges.map((exchange) =>
				exchangeEvidence(exchange, "id", exchange.responseId),
			),
		],
	};
}

/**
 * Compare client spans with what the provider reported for the same
 * assessment call. Only successful exchanges of a recognized API carry truth.
 */
export function evaluateProviderTruth(
	probe: ProbeResult,
	variantId: string,
	spans: readonly CapturedSpan[],
	calls: readonly ProviderCallSummary[],
): Observation[] {
	const spansById = new Map(spans.map((span) => [spanKey(span), span]));
	const clientsByCall = new Map<string, CapturedSpan[]>();
	for (const span of spans.filter(isClientSpan)) {
		const call = callAncestor(span, spansById);
		const callId = call && assessmentCallId(call);
		if (!callId) continue;
		clientsByCall.set(callId, [...(clientsByCall.get(callId) ?? []), span]);
	}

	return calls.flatMap((call) => {
		const exchanges = call.exchanges.filter(
			(exchange) =>
				exchange.status >= 200 &&
				exchange.status < 300 &&
				exchange.api !== undefined,
		);
		if (exchanges.length === 0) return [];
		const clients = clientsByCall.get(call.callId) ?? [];
		return [
			providerCallObservation(
				probe,
				variantId,
				call.callId,
				exchanges,
				clients,
			),
			...matchExchanges(exchanges, clients).flatMap(([exchange, span]) => [
				...usageObservations(probe, variantId, span, exchange),
				...identityObservations(probe, variantId, span, exchange),
			]),
		];
	});
}
