/**
 * Failure detectability: for each injected agent failure, was Sentry's
 * telemetry sufficient to detect it, and if not, which data was missing?
 *
 * Ground truth never comes from spans. Each run is labelled from the program's
 * own log (tools it ran, with which arguments; the answer it got; how it
 * ended) and from provider exchanges recorded by the provider-truth proxy
 * (scripted HTTP 500s, finish reasons). The detectors (a port of SpanProof's)
 * then run over the call's captured spans. A real model does not always fail
 * the way a fault intends, so a run whose failure did not happen is
 * "not_triggered", never counted for or against detectability.
 */
import type {
	AgentRunLog,
	CapturedSpan,
	DetectabilityResult,
	Evidence,
	Observation,
	ProbeResult,
	ProviderCallSummary,
	ProviderExchangeSummary,
} from "../../assessment/types.js";
import type { AgentProbeInput, FailureClass } from "../../probes/inputs.js";
import {
	ACKNOWLEDGED,
	CLIENT_OPS,
	OUTPUT_CHARS,
	FINISH_ATTRIBUTES,
	LENGTH_STOP,
	OUTPUT_ATTRIBUTES,
	STATUS_CODE_ATTRIBUTES,
	TOOL_ARGUMENT_ATTRIBUTES,
	TOOL_RESULT_ATTRIBUTES,
	TOOL_STOP,
	detectTrace,
	finishReasons,
	isClient,
	isProviderHttpSpan,
	outputText,
	statusCode,
	texts,
	toolArguments,
	toolText,
} from "../detectors.js";
import { assessmentCallId, callAncestor, spanKey } from "./spans.js";

export const FAILURE_CLASSES: readonly FailureClass[] = [
	"tool_loop",
	"retry_storm",
	"silent_tool_error",
	"dead_end",
	"truncated_answer",
];

/**
 * Classes judged on every run: the injected classes plus empty_answer, which
 * no probe injects but real runs produce (a model that stops with no text).
 */
export type JudgedClass = FailureClass | "empty_answer";
export const JUDGED_CLASSES: readonly JudgedClass[] = [
	...FAILURE_CLASSES,
	"empty_answer",
];

interface Reason {
	id: string;
	detail: string;
}

/** Spans recorded under one assessment call (the call span itself excluded). */
export function callSpans(
	spans: readonly CapturedSpan[],
	callId: string,
): CapturedSpan[] {
	const byKey = new Map(spans.map((span) => [spanKey(span), span]));
	return spans.filter((span) => {
		if (assessmentCallId(span)) return false;
		const ancestor = callAncestor(span, byKey);
		return ancestor !== undefined && assessmentCallId(ancestor) === callId;
	});
}

function successfulExchanges(
	call: ProviderCallSummary | undefined,
): ProviderExchangeSummary[] {
	return (call?.exchanges ?? []).filter(
		(exchange) =>
			!exchange.injectedFault && exchange.status >= 200 && exchange.status < 300,
	);
}

function maxRepeats(log: AgentRunLog): number {
	const counts = new Map<string, number>();
	for (const tool of log.tools) {
		const key = `${tool.name}\u0000${tool.arguments}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return Math.max(0, ...counts.values());
}

function hasAnswer(log: AgentRunLog): boolean {
	return typeof log.answer === "string" && log.answer.trim() !== "";
}

function unexpectedError(log: AgentRunLog): boolean {
	return log.error !== undefined && !log.error.stepLimit;
}

function injectedFailures(call: ProviderCallSummary | undefined): number {
	return (call?.exchanges ?? []).filter((exchange) => exchange.injectedFault)
		.length;
}

/**
 * Longest run of consecutive failed provider responses (HTTP 5xx or 429), as
 * recorded: scripted faults and real upstream rate limits count alike.
 */
function failedStreak(call: ProviderCallSummary | undefined): number {
	let streak = 0;
	let best = 0;
	for (const exchange of call?.exchanges ?? []) {
		if (exchange.status >= 500 || exchange.status === 429) {
			streak += 1;
			best = Math.max(best, streak);
		} else {
			streak = 0;
		}
	}
	return best;
}

function lastProviderStop(
	call: ProviderCallSummary | undefined,
): string | undefined {
	const last = successfulExchanges(call).at(-1);
	return (last?.finishReason ?? last?.incompleteReason)?.toLowerCase();
}

/**
 * Every failure class the run actually exhibited, with the ground-truth
 * evidence for it. Sources: the program's own log (tool calls and arguments,
 * the answer, the step limit) and the recorded provider exchanges (scripted
 * 500s, the provider's finish reason). Spans are never consulted.
 */
export function observedFailures(
	log: AgentRunLog,
	call: ProviderCallSummary | undefined,
	input: AgentProbeInput | undefined,
): Map<JudgedClass, string> {
	const observed = new Map<JudgedClass, string>();
	const repeats = maxRepeats(log);
	if (repeats >= 3) {
		observed.set(
			"tool_loop",
			`program log: one tool called ${repeats}x with identical arguments`,
		);
	}
	const streak = failedStreak(call);
	if (streak >= 3) {
		const injected = injectedFailures(call);
		observed.set(
			"retry_storm",
			`provider exchanges: ${streak} consecutive failed responses (${injected} scripted HTTP 500)`,
		);
	}
	const errorTools = new Set(
		(input?.tools ?? [])
			.filter((tool) => tool.errorPayload)
			.map((tool) => tool.name),
	);
	const failedTool = log.tools.find((tool) => errorTools.has(tool.name));
	if (
		failedTool &&
		!log.error &&
		hasAnswer(log) &&
		!ACKNOWLEDGED.test(log.answer as string)
	) {
		observed.set(
			"silent_tool_error",
			`program log: ${failedTool.name} returned an error payload and the answer does not acknowledge it`,
		);
	}
	const stop = lastProviderStop(call);
	const last = successfulExchanges(call).at(-1);
	const wantedTools =
		last?.toolCalls === true || (stop !== undefined && TOOL_STOP.has(stop));
	if (
		log.tools.length > 0 &&
		(log.error?.stepLimit || (!log.error && !hasAnswer(log) && wantedTools))
	) {
		observed.set(
			"dead_end",
			log.error?.stepLimit
				? `program log: step limit reached (${log.error.type}) after ${log.tools.length} tool call(s), no final answer`
				: `program log: no final answer after ${log.tools.length} tool call(s); the last provider response asked for more tools`,
		);
	}
	if (
		!log.error &&
		!hasAnswer(log) &&
		last !== undefined &&
		!wantedTools &&
		!(stop !== undefined && LENGTH_STOP.has(stop))
	) {
		observed.set(
			"empty_answer",
			`program log: the run finished with an empty answer; the last provider response stopped with ${stop ?? "an unreported reason"}`,
		);
	}
	if (stop && LENGTH_STOP.has(stop)) {
		observed.set(
			"truncated_answer",
			`provider exchange: final response stopped with ${stop}`,
		);
	}
	return observed;
}

/** Why the injected class did not happen (negative runs), from the same sources. */
export function notTriggeredLabel(
	failureClass: JudgedClass | undefined,
	log: AgentRunLog,
	call: ProviderCallSummary | undefined,
	input: AgentProbeInput | undefined,
): string {
	if (unexpectedError(log)) return `run_error:${log.error?.type}`;
	switch (failureClass) {
		case undefined:
			return hasAnswer(log) ? "healthy" : "no_answer";
		case "tool_loop":
			if (log.tools.length >= 3) return "varied_arguments";
			return log.tools.length > 0 ? "gave_up" : "tool_not_called";
		case "retry_storm":
			return injectedFailures(call) === 0 ? "fault_not_served" : "client_gave_up";
		case "silent_tool_error": {
			const errorTools = new Set(
				(input?.tools ?? []).filter((tool) => tool.errorPayload).map((tool) => tool.name),
			);
			if (!log.tools.some((tool) => errorTools.has(tool.name))) return "tool_not_called";
			if (log.error?.stepLimit) return "retried_until_step_limit";
			if (!hasAnswer(log)) return "no_answer";
			return "acknowledged";
		}
		case "dead_end":
			return log.tools.length === 0 ? "answered_without_tools" : "answered";
		case "truncated_answer":
			return successfulExchanges(call).length === 0
				? "no_provider_response"
				: `finished:${lastProviderStop(call) ?? "unreported"}`;
		case "empty_answer":
			return hasAnswer(log) ? "answered" : "no_answer_other_cause";
	}
}

function present(span: CapturedSpan, attributes: readonly string[]): boolean {
	return attributes.some((attribute) => {
		const value = span.data?.[attribute];
		return value !== undefined && value !== null;
	});
}

function start(span: CapturedSpan): number {
	return typeof span.start_timestamp === "number" ? span.start_timestamp : 0;
}

function ordered(spans: readonly CapturedSpan[]): CapturedSpan[] {
	return [...spans].sort((left, right) => start(left) - start(right));
}

function piiNote(log: AgentRunLog): string {
	if (log.genAIDataCollection === false) return " (AI data collection off)";
	return log.sendDefaultPii === false ? " (send_default_pii off)" : "";
}

function opsOf(spans: readonly CapturedSpan[]): string {
	const ops = [...new Set(spans.map((span) => span.op).filter(Boolean))].sort();
	return ops.length > 0 ? ops.join(", ") : "none";
}

/**
 * Generic coverage gaps shared by every class: is there an LLM-call span for
 * every successful provider request, and an agent span for the run?
 */
function clientCoverage(
	spans: readonly CapturedSpan[],
	call: ProviderCallSummary | undefined,
): Reason[] {
	const reasons: Reason[] = [];
	const clients = spans.filter(isClient);
	const requests = successfulExchanges(call).length;
	if (spans.length === 0) {
		reasons.push({
			id: "spans.none",
			detail: "No spans were captured under the assessment call.",
		});
		return reasons;
	}
	if (clients.length === 0) {
		const genAi = spans.filter((span) => span.op?.startsWith("gen_ai"));
		reasons.push({
			id: "client.span_missing",
			detail: `${requests} provider request(s) but no LLM-call span with op in {${[...CLIENT_OPS].join(", ")}} or gen_ai.operation.type=ai_client; gen_ai ops seen: ${opsOf(genAi)}.`,
		});
	} else if (clients.length < requests) {
		reasons.push({
			id: "client.span_partial",
			detail: `${requests} provider request(s) but ${clients.length} LLM-call span(s).`,
		});
	}
	return reasons;
}

function toolReasons(
	spans: readonly CapturedSpan[],
	log: AgentRunLog,
	needs: { arguments?: boolean; result?: boolean },
): Reason[] {
	const reasons: Reason[] = [];
	const tools = spans.filter((span) => span.op === "gen_ai.execute_tool");
	if (log.tools.length > 0 && tools.length === 0) {
		reasons.push({
			id: "tool.span_missing",
			detail: `The program ran ${log.tools.length} tool call(s); no gen_ai.execute_tool span was captured.`,
		});
		return reasons;
	}
	if (tools.length < log.tools.length) {
		reasons.push({
			id: "tool.span_partial",
			detail: `The program ran ${log.tools.length} tool call(s); ${tools.length} gen_ai.execute_tool span(s) were captured.`,
		});
	}
	if (needs.arguments) {
		const without = tools.filter(
			(span) => !present(span, TOOL_ARGUMENT_ATTRIBUTES),
		);
		if (without.length > 0) {
			reasons.push({
				id: "tool.arguments_missing",
				detail: `${without.length}/${tools.length} tool span(s) have no ${TOOL_ARGUMENT_ATTRIBUTES.join(" or ")}${piiNote(log)}.`,
			});
		} else {
			const distinct = new Set(tools.map((span) => toolArguments(span)));
			const logged = new Set(log.tools.map((tool) => tool.arguments));
			if (distinct.size > logged.size) {
				reasons.push({
					id: "tool.arguments_unstable",
					detail: `Identical logged arguments were recorded as ${distinct.size} different values.`,
				});
			}
		}
	}
	if (needs.result) {
		const without = tools.filter(
			(span) =>
				!present(span, TOOL_RESULT_ATTRIBUTES) &&
				(span.status === undefined || span.status === "ok"),
		);
		if (without.length > 0) {
			reasons.push({
				id: "tool.result_missing",
				detail: `${without.length}/${tools.length} tool span(s) have no ${TOOL_RESULT_ATTRIBUTES.join(" or ")} and no error status${piiNote(log)}.`,
			});
		}
	}
	return reasons;
}

function finishReasonGaps(
	final: CapturedSpan | undefined,
	expected: ReadonlySet<string>,
	providerReason: string | undefined,
	label: string,
): Reason[] {
	if (!final) return [];
	if (!present(final, FINISH_ATTRIBUTES)) {
		return [
			{
				id: "finish_reason.missing",
				detail: `The final LLM-call span (${final.op}) has no ${FINISH_ATTRIBUTES.join(" or ")}${providerReason ? `; the provider reported ${providerReason}` : ""}.`,
			},
		];
	}
	const reasons = [...finishReasons(final)];
	if (!reasons.some((reason) => expected.has(reason))) {
		return [
			{
				id: "finish_reason.mismatch",
				detail: `The final LLM-call span records finish reason ${JSON.stringify(reasons)}, not a ${label} reason${providerReason ? `; the provider reported ${providerReason}` : ""}.`,
			},
		];
	}
	return [];
}

function lastProviderReason(
	call: ProviderCallSummary | undefined,
): string | undefined {
	const last = successfulExchanges(call).at(-1);
	return last?.finishReason ?? last?.incompleteReason;
}

/**
 * For a run where the injected failure did not happen: would the telemetry
 * have carried what the rule reads, had it happened? Presence checks only.
 */
export function dataGaps(
	failureClass: FailureClass,
	spans: readonly CapturedSpan[],
	log: AgentRunLog,
	call: ProviderCallSummary | undefined,
): Reason[] {
	const reasons: Reason[] = [...clientCoverage(spans, call)];
	const clients = ordered(spans.filter(isClient));
	const final = clients.at(-1);
	const agents = spans.filter((span) => span.op === "gen_ai.invoke_agent");
	switch (failureClass) {
		case "tool_loop":
			reasons.push(...toolReasons(spans, log, { arguments: true }));
			break;
		case "silent_tool_error": {
			reasons.push(...toolReasons(spans, log, { result: true }));
			const answer = [final, agents[0]]
				.filter((span): span is CapturedSpan => span !== undefined)
				.map((span) => outputText(span))
				.find((value) => value !== undefined && value !== null);
			if (final && answer === undefined) {
				reasons.push({
					id: "answer.missing",
					detail: `Neither the final LLM-call span nor the agent span has ${OUTPUT_ATTRIBUTES.join(" or ")}${piiNote(log)}.`,
				});
			}
			const tools = spans.filter((span) => span.op === "gen_ai.execute_tool");
			const recognized = tools.some(
				(span) =>
					detectTrace([
						// Judge the recorded result alone: a healthy agent and a plain answer.
						...(agents[0] ? [{ ...agents[0], status: "ok" }] : []),
						span,
						{
							...(final ?? span),
							span_id: "probe-answer",
							start_timestamp: Number.MAX_SAFE_INTEGER,
							op: "gen_ai.chat",
							data: { "gen_ai.response.text": "Done." },
						},
					]).some((detection) => detection.kind === "silent_tool_error"),
			);
			const withResult = tools.filter((span) => toolText(span) !== undefined);
			if (withResult.length > 0 && !recognized) {
				reasons.push({
					id: "tool.result_unrecognized",
					detail: `The rule does not read the recorded tool result as an error: ${JSON.stringify((tools.map((span) => toolText(span)).find(Boolean) ?? "").slice(0, 120))}.`,
				});
			}
			break;
		}
		case "dead_end":
		case "truncated_answer":
			if (final && !present(final, FINISH_ATTRIBUTES)) {
				reasons.push({
					id: "finish_reason.missing",
					detail: `The final LLM-call span (${final.op}) has no ${FINISH_ATTRIBUTES.join(" or ")}.`,
				});
			}
			break;
		case "retry_storm":
			if (!spans.some(isProviderHttpSpan)) {
				reasons.push({
					id: "http.span_missing",
					detail: "No http.client span for a provider path was captured.",
				});
			}
			break;
	}
	return reasons;
}

/** Why the detector could not see a failure that happened. */
export function missingEvidence(
	failureClass: JudgedClass,
	spans: readonly CapturedSpan[],
	log: AgentRunLog,
	call: ProviderCallSummary | undefined,
): Reason[] {
	const reasons: Reason[] = [];
	const clients = ordered(spans.filter(isClient));
	const final = clients.at(-1);
	const agents = spans.filter((span) => span.op === "gen_ai.invoke_agent");
	switch (failureClass) {
		case "tool_loop":
			reasons.push(...toolReasons(spans, log, { arguments: true }));
			break;
		case "retry_storm": {
			const injected = failedStreak(call);
			const http = spans.filter(isProviderHttpSpan);
			const anyHttp = spans.filter((span) =>
				(span.op ?? "").startsWith("http.client"),
			);
			if (http.length === 0) {
				reasons.push({
					id: "http.span_missing",
					detail: `The provider failed ${injected} consecutive request(s); no http.client span for a provider path was captured (http.client spans: ${anyHttp.length}).`,
				});
				break;
			}
			const withoutStatus = http.filter((span) => statusCode(span) === undefined);
			if (withoutStatus.length > 0) {
				reasons.push({
					id: "http.status_missing",
					detail: `${withoutStatus.length}/${http.length} provider http.client span(s) have no ${STATUS_CODE_ATTRIBUTES.join(" or ")}.`,
				});
			}
			const failed = http.filter((span) => {
				const code = statusCode(span) ?? 0;
				return code >= 500 || code === 429;
			});
			if (failed.length < injected && withoutStatus.length === 0) {
				reasons.push({
					id: "http.span_partial",
					detail: `The provider failed ${injected} consecutive request(s); ${failed.length} failed provider http.client span(s) were captured.`,
				});
			}
			break;
		}
		case "silent_tool_error": {
			reasons.push(...toolReasons(spans, log, { result: true }));
			if (!final) break;
			const tools = ordered(
				spans.filter((span) => span.op === "gen_ai.execute_tool"),
			);
			const lastTool = tools.at(-1);
			if (lastTool && start(final) <= start(lastTool)) {
				reasons.push({
					id: "client.order",
					detail: "No LLM-call span starts after the failing tool span.",
				});
			}
			let answer = outputText(final);
			if ((answer === undefined || answer === null) && agents[0]) {
				answer = outputText(agents[0]);
			}
			if (answer === undefined || answer === null) {
				reasons.push({
					id: "answer.missing",
					detail: `Neither the final LLM-call span nor the agent span has ${OUTPUT_ATTRIBUTES.join(" or ")}, so a silent failure cannot be told from an acknowledged one${piiNote(log)}.`,
				});
			} else if (ACKNOWLEDGED.test(texts(answer))) {
				reasons.push({
					id: "answer.differs",
					detail: "The recorded answer text acknowledges a failure, but the program's answer does not.",
				});
			}
			if ([...finishReasons(final)].some((reason) => TOOL_STOP.has(reason))) {
				reasons.push({
					id: "finish_reason.mismatch",
					detail: "The final LLM-call span records a tool-call finish reason although the run answered.",
				});
			}
			const agent = agents[0];
			if (agent && agent.status !== undefined && agent.status !== "ok") {
				reasons.push({
					id: "agent.status_error",
					detail: `The agent span has status ${String(agent.status)} although the run returned an answer.`,
				});
			}
			const result = tools.map((span) => toolText(span)).find(Boolean);
			if (
				result !== undefined &&
				!reasons.some((reason) => reason.id.startsWith("tool."))
			) {
				// Result recorded but the detector did not treat it as an error.
				reasons.push({
					id: "tool.result_unrecognized",
					detail: `The tool result was recorded as ${JSON.stringify(result.slice(0, 120))}.`,
				});
			}
			break;
		}
		case "dead_end": {
			const providerReason = lastProviderReason(call);
			const viaFinish = finishReasonGaps(
				final,
				TOOL_STOP,
				providerReason,
				"tool-call",
			);
			// The alternative signal: an errored agent span whose last tool
			// follows the last LLM call (only when the run raised).
			const agent = agents[0];
			if (log.error?.stepLimit) {
				if (!agent) {
					viaFinish.push({
						id: "agent.span_missing",
						detail: "The run raised its step limit, but no gen_ai.invoke_agent span was captured to carry an error status.",
					});
				} else if (agent.status === undefined || agent.status === "ok") {
					viaFinish.push({
						id: "agent.status_unset",
						detail: `The run raised ${log.error.type}, but the gen_ai.invoke_agent span status is ${String(agent.status ?? "unset")}.`,
					});
				}
			}
			reasons.push(...viaFinish);
			break;
		}
		case "empty_answer": {
			const own = final ? outputText(final) : undefined;
			const fallback = agents[0] ? outputText(agents[0]) : undefined;
			if (final && (own === undefined || own === null)) {
				const agentText =
					fallback === undefined || fallback === null
						? undefined
						: texts(fallback).trim();
				reasons.push({
					id: "answer.absent_when_empty",
					detail: `The final LLM-call span has no ${OUTPUT_ATTRIBUTES.join(" or ")} and no ${OUTPUT_CHARS}: an empty response is recorded as absent, which a detector must treat as unknown${agentText ? `; the agent span's output instead holds ${JSON.stringify(agentText.slice(0, 100))}` : ""}${piiNote(log)}.`,
				});
			} else if (final && texts(own).trim() !== "") {
				reasons.push({
					id: "answer.differs",
					detail: `The recorded answer is not empty: ${JSON.stringify(texts(own).slice(0, 120))}.`,
				});
			}
			if (final) {
				const finish = [...finishReasons(final)];
				if (finish.some((reason) => TOOL_STOP.has(reason) || LENGTH_STOP.has(reason))) {
					reasons.push({
						id: "finish_reason.mismatch",
						detail: `The final LLM-call span records finish reason ${JSON.stringify(finish)}, which routes the run to another rule.`,
					});
				}
			}
			break;
		}
		case "truncated_answer":
			reasons.push(
				...finishReasonGaps(
					final,
					LENGTH_STOP,
					lastProviderReason(call),
					"length",
				),
			);
			break;
	}
	// The answer and finish-reason rules read the final LLM-call span; without
	// one, nothing else can be checked.
	if (
		failureClass === "silent_tool_error" ||
		failureClass === "dead_end" ||
		failureClass === "truncated_answer" ||
		failureClass === "empty_answer"
	) {
		reasons.unshift(...clientCoverage(spans, call));
	}
	return reasons;
}

function evidenceFor(reasons: readonly Reason[]): Evidence[] {
	return reasons.map((reason) => ({
		attribute: reason.id,
		description: reason.detail,
	}));
}

function failureClassOf(input: AgentProbeInput | undefined): FailureClass | undefined {
	return input?.fault?.failureClass;
}

export interface DetectabilityEvaluation {
	observations: Observation[];
	results: DetectabilityResult[];
}

/**
 * Evaluate one failure-injection probe. For each logged run, every class the
 * run actually exhibited is judged (detectable or undetectable with reasons),
 * the injected class is reported as not triggered when it did not happen, and
 * any detector firing on a class the run did not exhibit is a false alarm.
 */
export function evaluateDetectability(
	probe: ProbeResult,
	variantId: string,
	spans: readonly CapturedSpan[],
	input: AgentProbeInput | undefined,
	logs: readonly AgentRunLog[],
	providerCalls: readonly ProviderCallSummary[],
): DetectabilityEvaluation {
	const injected = failureClassOf(input);
	const observations: Observation[] = [];
	const results: DetectabilityResult[] = [];
	for (const log of logs) {
		if (log.probeId !== probe.probeId) continue;
		const call = providerCalls.find((entry) => entry.callId === log.callId);
		const scoped = callSpans(spans, log.callId);
		const detections = [...new Set(detectTrace(scoped).map((entry) => entry.kind))];
		const observed = observedFailures(log, call, input);
		const callMode: "blocking" | "streaming" = log.callId.includes(":streaming:")
			? "streaming"
			: "blocking";
		const judged = new Set<JudgedClass>([
			...observed.keys(),
			...(injected ? [injected] : []),
			...JUDGED_CLASSES.filter((kind) => detections.includes(kind)),
		]);
		const record = (
			failureClass: string,
			verdict: DetectabilityResult["verdict"],
			label: string,
			reasons: Reason[],
			state: Observation["state"],
		) => {
			results.push({
				probeId: probe.probeId,
				callId: log.callId,
				callMode,
				failureClass,
				injected: failureClass === (injected ?? "control"),
				label,
				verdict,
				detections,
				reasons,
				...(log.sendDefaultPii !== undefined
					? { sendDefaultPii: log.sendDefaultPii }
					: {}),
				...(log.genAIDataCollection !== undefined
					? { genAIDataCollection: log.genAIDataCollection }
					: {}),
			});
			observations.push({
				observationId: `detect.${failureClass}.${verdict}:${log.callId}`,
				capability: `detect.${failureClass}`,
				state,
				probeId: probe.probeId,
				variantId,
				expected: { observed: [...observed.keys()] },
				actual: { detections },
				evidence: evidenceFor(reasons),
			});
		};
		for (const failureClass of JUDGED_CLASSES) {
			if (!judged.has(failureClass)) continue;
			const fired = detections.includes(failureClass);
			const truth = observed.get(failureClass);
			if (truth !== undefined) {
				if (fired) {
					record(failureClass, "detectable", failureClass, [], "healthy");
					continue;
				}
				const reasons = missingEvidence(failureClass, scoped, log, call);
				if (reasons.length === 0) {
					reasons.push({
						id: "detector.rule_missed",
						detail: `The data the ${failureClass} rule reads looks present, but the rule did not fire; detections: ${JSON.stringify(detections)}.`,
					});
				}
				record(failureClass, "undetectable", failureClass, reasons, "missing");
				continue;
			}
			const label = notTriggeredLabel(failureClass, log, call, input);
			if (fired) {
				record(
					failureClass,
					"false_alarm",
					label,
					[
						{
							id: `false_alarm.${failureClass}`,
							detail: `${failureClass} fired, but the program log and provider exchanges show no ${failureClass} (${label}).`,
						},
					],
					"malformed",
				);
			} else {
				record(
					failureClass,
					"not_triggered",
					label,
					failureClass === "empty_answer"
						? []
						: dataGaps(failureClass, scoped, log, call),
					"blocked",
				);
			}
		}
		if (!injected && judged.size === 0) {
			// A control run that errored or gave no answer proves nothing: not healthy.
			const label = notTriggeredLabel(undefined, log, call, input);
			record("control", "not_applicable", label, [], label === "healthy" ? "healthy" : "blocked");
		}
	}
	return { observations, results };
}
