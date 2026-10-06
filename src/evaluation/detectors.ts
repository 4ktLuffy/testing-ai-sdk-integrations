/**
 * Agent failure-class detectors over one trace's spans.
 *
 * TypeScript port of SpanProof's `spanproof/detectors.py` (detect_trace). The
 * detectors read only what Sentry receives in production (gen_ai.* and
 * http.client spans): no ground truth and no extra instrumentation. Rules,
 * thresholds, and regular expressions are kept identical to the reference so
 * results stay comparable; deviations are called out where they occur.
 */
import type { CapturedSpan } from "../assessment/types.js";

export type DetectionKind =
	| "lost_llm_span"
	| "retry_storm"
	| "tool_loop"
	| "silent_tool_error"
	| "dead_end"
	| "truncated_answer"
	| "empty_answer";

export interface Detection {
	kind: DetectionKind;
	title: string;
	traceId: string;
	agent?: string;
	evidence: string[];
	detail: Record<string, unknown>;
}

export const LLM_PATH =
	/(\/chat\/completions|\/responses\b|\/v1\/messages|:generateContent|:streamGenerateContent|\/v1\/completions|\/embeddings)/;

const ERROR_TEXT: readonly RegExp[] = [
	/^\s*\{\s*"error"\s*:/i,
	/\berror occurred\b/i,
	/\btraceback \(most recent call last\)/i,
	/\b(exception|errno)\b/i,
	/\b(5\d\d|429)\b[^\n]{0,40}\b(unavailable|error|timeout|overloaded)\b/i,
	/\btimed? ?out\b/i,
	/^\s*[A-Z][A-Za-z]*(Error|Exception|Timeout)\b\s*:/,
	/\b(unreachable|refused|disconnected)\b/i,
];
const BENIGN = /\bno (errors?|exceptions?|issues?) (found|detected)\b/i;
export const TOOL_STOP = new Set([
	"tool_calls",
	"tool_use",
	"function_call",
	"tool-calls",
	"tool_call",
]);
export const LENGTH_STOP = new Set(["length", "max_tokens", "max_output_tokens"]);
/** The final answer tells the user the step failed: then the failure is not silent. */
export const ACKNOWLEDGED =
	/\b(timed? ?out|failed|unable|could ?n[o']t|cannot|can't|unavailable|did not respond|error|sorry|try again|retry later)\b/i;
export const CLIENT_OPS = new Set([
	"gen_ai.chat",
	"gen_ai.responses",
	"gen_ai.text_completion",
	"gen_ai.generate_content",
	"gen_ai.embeddings",
	"gen_ai.completion",
]);

/**
 * Proposed attribute (not emitted by any SDK today): a salted hash of the
 * tool-call arguments, safe to send with data collection off.
 */
export const ARGS_HASH = "gen_ai.tool.call.arguments_hash";
/** Proposed attribute: the character count of the response text. */
export const OUTPUT_CHARS = "gen_ai.response.text_length";

export const TOOL_ARGUMENT_ATTRIBUTES = [
	"gen_ai.tool.call.arguments",
	"gen_ai.tool.input",
] as const;
export const TOOL_RESULT_ATTRIBUTES = [
	"gen_ai.tool.call.result",
	"gen_ai.tool.output",
] as const;
export const OUTPUT_ATTRIBUTES = [
	"gen_ai.output.messages",
	"gen_ai.response.text",
] as const;
export const FINISH_ATTRIBUTES = [
	"gen_ai.response.finish_reasons",
	"gen_ai.response.finish_reason",
] as const;
export const STATUS_CODE_ATTRIBUTES = [
	"http.response.status_code",
	"http.status_code",
] as const;

type Data = Record<string, unknown>;

function data(span: CapturedSpan): Data {
	return span.data ?? {};
}

function has(record: Data, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function parentId(span: CapturedSpan): string | undefined {
	return typeof span.parent_span_id === "string"
		? span.parent_span_id
		: undefined;
}

function start(span: CapturedSpan): number {
	return typeof span.start_timestamp === "number" ? span.start_timestamp : 0;
}

function statusOk(span: CapturedSpan | undefined): boolean {
	const status = span?.status;
	return status === undefined || status === null || status === "ok";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/** JSON with sorted object keys, like Python's json.dumps(sort_keys=True). */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isPlainObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function isJsonObject(text: string): boolean {
	const parsed = parseJson(text);
	return parsed.ok && isPlainObject(parsed.value);
}

/** A JSON tool result that says it failed: an "error" value, ok/success false, or status error. */
export function structuredError(text: string): boolean {
	const parsed = parseJson(text);
	if (!parsed.ok || !isPlainObject(parsed.value)) return false;
	const value = parsed.value;
	const error = value.error;
	const emptyError =
		error === undefined ||
		error === null ||
		error === false ||
		error === "" ||
		(Array.isArray(error) && error.length === 0) ||
		(isPlainObject(error) && Object.keys(error).length === 0);
	if (!emptyError) return true;
	if (value.ok === false || value.success === false) return true;
	return ["error", "failed", "failure"].includes(
		String(value.status ?? "").toLowerCase(),
	);
}

/** finish_reasons arrive as JSON ('["stop"]'), Python repr ("['stop']") or a bare string. */
function parseListish(value: string): unknown[] {
	const parsed = parseJson(value);
	if (parsed.ok) {
		return Array.isArray(parsed.value) ? parsed.value : [parsed.value];
	}
	const trimmed = value.trim();
	if (/^[[(].*[\])]$/s.test(trimmed)) {
		const asJson = parseJson(
			`[${trimmed.slice(1, -1).replace(/'/g, '"').replace(/,\s*$/, "")}]`,
		);
		if (asJson.ok && Array.isArray(asJson.value)) return asJson.value;
	}
	return [value];
}

/** All human-readable text inside an output value (JSON strings, message lists, parts). */
export function texts(value: unknown): string {
	if (value === undefined || value === null) return "";
	let current: unknown = value;
	if (typeof current === "string") {
		const parsed = parseJson(current);
		if (!parsed.ok) return current;
		if (typeof parsed.value === "string") return parsed.value;
		current = parsed.value;
	}
	if (isPlainObject(current)) {
		const keys = ["content", "text", "parts"].filter((key) =>
			has(current as Data, key),
		);
		// An application's own JSON answer, not a message wrapper.
		if (keys.length === 0) return JSON.stringify(current);
		return keys.map((key) => texts((current as Data)[key])).join(" ");
	}
	if (Array.isArray(current)) return current.map(texts).join(" ");
	return String(current); // numbers and booleans are answers too
}

export function isClient(span: CapturedSpan): boolean {
	return (
		CLIENT_OPS.has(span.op) ||
		data(span)["gen_ai.operation.type"] === "ai_client"
	);
}

export function statusCode(span: CapturedSpan): number | undefined {
	const record = data(span);
	const value =
		record["http.response.status_code"] || record["http.status_code"];
	const parsed =
		typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isInteger(parsed) ? parsed : undefined;
}

export function finishReasons(span: CapturedSpan): Set<string> {
	const record = data(span);
	let value: unknown = record["gen_ai.response.finish_reasons"];
	if (value === undefined || value === null) {
		value = record["gen_ai.response.finish_reason"];
	}
	let values: unknown[];
	if (typeof value === "string") values = parseListish(value);
	else if (Array.isArray(value)) values = value;
	else if (value === undefined || value === null) values = [];
	else values = [value];
	return new Set(values.map((entry) => String(entry).toLowerCase()));
}

export function toolText(span: CapturedSpan): string | undefined {
	const record = data(span);
	for (const key of TOOL_RESULT_ATTRIBUTES) {
		const value = record[key];
		if (!has(record, key) || value === null || value === undefined) continue;
		if (typeof value === "string") {
			// LangChain wraps outputs as a serialized message.
			const parsed = parseJson(value);
			if (
				parsed.ok &&
				isPlainObject(parsed.value) &&
				typeof parsed.value.content === "string"
			) {
				return parsed.value.content;
			}
			// Deviation from the reference: the Vercel AI SDK integration
			// records the whole tool-result part; read its output.
			if (
				parsed.ok &&
				isPlainObject(parsed.value) &&
				parsed.value.type === "tool-result" &&
				has(parsed.value, "output")
			) {
				const output = parsed.value.output;
				if (typeof output === "string") return output;
				if (isPlainObject(output) && typeof output.value === "string") {
					return output.value;
				}
				return JSON.stringify(output);
			}
			return value;
		}
		return JSON.stringify(value);
	}
	return undefined;
}

export function toolArguments(span: CapturedSpan): string | undefined {
	const record = data(span);
	if (record[ARGS_HASH]) return `sha256:${String(record[ARGS_HASH])}`;
	for (const key of TOOL_ARGUMENT_ATTRIBUTES) {
		const value = record[key];
		if (!has(record, key) || value === null || value === undefined) continue;
		if (typeof value === "string") {
			const parsed = parseJson(value);
			if (!parsed.ok) return value.trim();
			return stableJson(parsed.value);
		}
		return stableJson(value);
	}
	return undefined;
}

export function outputText(span: CapturedSpan): unknown {
	const record = data(span);
	for (const key of OUTPUT_ATTRIBUTES) {
		if (has(record, key)) return record[key];
	}
	return undefined;
}

function ordered(spans: readonly CapturedSpan[]): CapturedSpan[] {
	return [...spans].sort((left, right) => start(left) - start(right));
}

function toolName(span: CapturedSpan): string | undefined {
	const name = data(span)["gen_ai.tool.name"];
	return typeof name === "string" && name ? name : span.description;
}

interface AgentRun {
	agent?: string;
	agentSpan?: CapturedSpan;
	spans: CapturedSpan[];
}

/** One entry per outermost agent run; the whole trace when there is no agent span. */
function runs(spans: readonly CapturedSpan[]): AgentRun[] {
	const byParent = new Map<string | undefined, CapturedSpan[]>();
	for (const span of spans) {
		const key = parentId(span);
		byParent.set(key, [...(byParent.get(key) ?? []), span]);
	}
	const descendants = (root: CapturedSpan): CapturedSpan[] => {
		const seen = new Set([root.span_id]);
		const out: CapturedSpan[] = [];
		const stack = [...(byParent.get(root.span_id) ?? [])];
		while (stack.length > 0) {
			const span = stack.pop() as CapturedSpan;
			if (seen.has(span.span_id)) continue;
			seen.add(span.span_id);
			out.push(span);
			stack.push(...(byParent.get(span.span_id) ?? []));
		}
		return out;
	};
	const agents = spans.filter((span) => span.op === "gen_ai.invoke_agent");
	const agentIds = new Set(agents.map((span) => span.span_id));
	const byId = new Map(spans.map((span) => [span.span_id, span]));
	const hasAgentAncestor = (span: CapturedSpan): boolean => {
		let parent = parentId(span);
		const seen = new Set([span.span_id]);
		while (parent !== undefined && byId.has(parent) && !seen.has(parent)) {
			if (agentIds.has(parent)) return true;
			seen.add(parent);
			parent = parentId(byId.get(parent) as CapturedSpan);
		}
		return false;
	};
	const outer = agents.filter((span) => !hasAgentAncestor(span));
	if (outer.length === 0) return [{ spans: [...spans] }];
	return outer.map((agentSpan) => {
		const name = data(agentSpan)["gen_ai.agent.name"];
		return {
			agent:
				typeof name === "string" && name ? name : agentSpan.description,
			agentSpan,
			spans: descendants(agentSpan),
		};
	});
}

/** The nearest enclosing agent span of a span (its own agent's scope). */
function scope(
	span: CapturedSpan,
	byId: ReadonlyMap<string, CapturedSpan>,
	agentIds: ReadonlySet<string>,
): string | undefined {
	let parent = parentId(span);
	const seen = new Set([span.span_id]);
	while (parent !== undefined && byId.has(parent) && !seen.has(parent)) {
		if (agentIds.has(parent)) return parent;
		seen.add(parent);
		parent = parentId(byId.get(parent) as CapturedSpan);
	}
	return undefined;
}

/**
 * URL attributes checked after the span description. Deviation from the
 * reference, which reads the description only: sentry-python names http.client
 * spans "POST <full url>", but @sentry/node names them "POST <host>" and keeps
 * the path in url.full / url.path.
 */
export const URL_ATTRIBUTES = ["url.full", "url.path", "http.url"] as const;

export function isProviderHttpSpan(span: CapturedSpan): boolean {
	if (!(span.op ?? "").startsWith("http.client")) return false;
	if (LLM_PATH.test(span.description ?? "")) return true;
	return URL_ATTRIBUTES.some((attribute) => {
		const value = span.data?.[attribute];
		return typeof value === "string" && LLM_PATH.test(value);
	});
}

/** Run every detector over one trace (or one assessment call's subtree). */
export function detectTrace(spans: readonly CapturedSpan[]): Detection[] {
	const out: Detection[] = [];
	if (spans.length === 0) return out;
	const trace = spans[0].trace_id || "-";

	// Trace-wide: provider calls without gen_ai spans; retry storms.
	const http = spans.filter(isProviderHttpSpan);
	const okHttp = http.filter((span) => (statusCode(span) ?? 200) < 400);
	const clients = spans.filter(isClient);
	if (okHttp.length > clients.length) {
		out.push({
			kind: "lost_llm_span",
			title: `${okHttp.length - clients.length} provider call(s) have no gen_ai span`,
			traceId: trace,
			evidence: okHttp.map((span) => span.span_id),
			detail: { provider_calls: okHttp.length, gen_ai_spans: clients.length },
		});
	}
	let streak = 0;
	let best = 0;
	const failedAttempts: string[] = [];
	for (const span of ordered(http)) {
		const code = statusCode(span);
		if (code !== undefined && (code >= 500 || code === 429)) {
			streak += 1;
			failedAttempts.push(span.span_id);
			best = Math.max(best, streak);
		} else {
			streak = 0;
		}
	}
	if (best >= 3) {
		out.push({
			kind: "retry_storm",
			title: `${best} consecutive failed provider attempts`,
			traceId: trace,
			evidence: failedAttempts,
			detail: { attempts: best },
		});
	}

	const byId = new Map(spans.map((span) => [span.span_id, span]));
	const agentIds = new Set(
		spans
			.filter((span) => span.op === "gen_ai.invoke_agent")
			.map((span) => span.span_id),
	);

	for (const { agent, agentSpan, spans: run } of runs(spans)) {
		const tools = ordered(
			run.filter((span) => span.op === "gen_ai.execute_tool"),
		);
		const chats = ordered(run.filter(isClient));

		// Tool loop: same tool and same arguments three times or more, within
		// one agent's own scope.
		const counts = new Map<
			string,
			{ name?: string; args?: string; ids: string[] }
		>();
		for (const tool of tools) {
			const name = toolName(tool);
			const args = toolArguments(tool);
			const key = JSON.stringify([scope(tool, byId, agentIds), name, args]);
			const entry = counts.get(key) ?? { name, args, ids: [] };
			entry.ids.push(tool.span_id);
			counts.set(key, entry);
		}
		for (const { name, args, ids } of counts.values()) {
			// With no arguments recorded (data collection off) a loop is
			// indistinguishable from pagination, so the rule does not guess.
			if (args !== undefined && ids.length >= 3) {
				out.push({
					kind: "tool_loop",
					title: `tool ${name} called ${ids.length}x with identical arguments`,
					traceId: trace,
					agent,
					evidence: ids,
					detail: { tool: name, calls: ids.length },
				});
			}
		}

		// Silent tool error: a tool failed, yet the run went on and answered.
		const final = chats.at(-1);
		let answerRaw = final !== undefined ? outputText(final) : undefined;
		if ((answerRaw === undefined || answerRaw === null) && agentSpan) {
			answerRaw = outputText(agentSpan);
		}
		for (const tool of tools) {
			const text = toolText(tool) ?? "";
			let failed: boolean;
			if (!statusOk(tool)) failed = true;
			else if (isJsonObject(text)) failed = structuredError(text);
			else {
				failed =
					ERROR_TEXT.some((pattern) => pattern.test(text)) &&
					!BENIGN.test(text);
			}
			if (!failed) continue;
			const answeredAfter =
				final !== undefined &&
				start(final) > start(tool) &&
				![...finishReasons(final)].some((reason) => TOOL_STOP.has(reason));
			const runOk = agentSpan === undefined || statusOk(agentSpan);
			// Without the answer's text a silent failure cannot be told from an acknowledged one.
			if (
				answeredAfter &&
				runOk &&
				answerRaw !== undefined &&
				answerRaw !== null &&
				!ACKNOWLEDGED.test(texts(answerRaw))
			) {
				const name = toolName(tool);
				out.push({
					kind: "silent_tool_error",
					title: `tool ${name} failed but the agent answered as if it succeeded`,
					traceId: trace,
					agent,
					evidence: [tool.span_id, (final as CapturedSpan).span_id],
					detail: { tool: name },
				});
				break;
			}
		}

		if (final !== undefined) {
			const finish = finishReasons(final);
			const lastTool = tools.at(-1);
			if (
				[...finish].some((reason) => TOOL_STOP.has(reason)) ||
				(agentSpan !== undefined &&
					!statusOk(agentSpan) &&
					lastTool !== undefined &&
					start(lastTool) > start(final))
			) {
				out.push({
					kind: "dead_end",
					title: "run stopped after a tool call without a final answer",
					traceId: trace,
					agent,
					evidence: [final.span_id],
					detail: { finish: [...finish].sort() },
				});
			} else if ([...finish].some((reason) => LENGTH_STOP.has(reason))) {
				out.push({
					kind: "truncated_answer",
					title: "final answer cut off by the token limit",
					traceId: trace,
					agent,
					evidence: [final.span_id],
					detail: { finish: [...finish].sort() },
				});
			} else {
				// Missing content is unknown, not empty; a token count alone proves nothing.
				let chars = data(final)[OUTPUT_CHARS];
				if (chars === undefined && agentSpan !== undefined) {
					chars = data(agentSpan)[OUTPUT_CHARS];
				}
				const empty =
					answerRaw !== undefined && answerRaw !== null
						? texts(answerRaw).trim() === ""
						: Number.isInteger(chars) && chars === 0;
				if (empty) {
					out.push({
						kind: "empty_answer",
						title: "final answer is empty",
						traceId: trace,
						agent,
						evidence: [final.span_id],
						detail: {},
					});
				}
			}
		}
	}
	return out;
}
