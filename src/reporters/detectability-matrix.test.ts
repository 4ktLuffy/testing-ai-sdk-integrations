import assert from "node:assert/strict";
import test from "node:test";
import type { DetectabilityResult, VariantAssessment } from "../assessment/types.js";
import {
	buildDetectabilityMatrix,
	renderDetectabilityHtml,
	renderDetectabilityMarkdown,
} from "./detectability-matrix.js";

function result(partial: Partial<DetectabilityResult>): DetectabilityResult {
	return {
		probeId: "agent.fault.truncated_answer",
		callId: "agent.fault.truncated_answer:blocking:0",
		failureClass: "truncated_answer",
		injected: true,
		label: "truncated_answer",
		verdict: "detectable",
		detections: [],
		reasons: [],
		sendDefaultPii: true,
		...partial,
	};
}

function variant(id: string, detectability: DetectabilityResult[]): VariantAssessment {
	return {
		id,
		identity: { frameworkVersion: "1", sentryVersion: "latest", executionMode: "async", options: {} },
		completion: "complete",
		health: "healthy",
		rating: "all_good",
		score: 100,
		probes: [],
		observations: [],
		findings: [],
		runtimeFailures: [],
		spans: [],
		detectability,
	} as unknown as VariantAssessment;
}

test("matrix cells count runs and keep reasons; repeated executions merge", () => {
	const missing = result({
		verdict: "undetectable",
		reasons: [{ id: "finish_reason.missing", detail: "no finish reason" }],
	});
	const rows = buildDetectabilityMatrix([
		variant("python/agents/x/framework=1", [
			missing,
			result({ probeId: "agent.fault.control", callId: "agent.fault.control:blocking:0", failureClass: "control", verdict: "not_applicable", label: "healthy" }),
			result({ probeId: "agent.fault.silent_tool_error", callId: "agent.fault.silent_tool_error:blocking:0", failureClass: "silent_tool_error", verdict: "not_triggered", label: "acknowledged" }),
		]),
		variant("python/agents/x/framework=1", [missing]),
		variant("python/agents/x/framework=1", [result({ sendDefaultPii: false })]),
	]);
	assert.equal(rows.length, 2);
	const [off, on] = rows;
	assert.equal(off.sendDefaultPii, false);
	assert.equal(off.cells.truncated_answer.text, "detectable 1/1");
	assert.equal(on.runs, 4);
	assert.equal(on.cells.truncated_answer.text, "not detectable 0/2 (finish_reason.missing x2)");
	assert.equal(on.cells.silent_tool_error.text, "not triggered (acknowledged); data present");
	assert.equal(on.cells.control.text, "quiet 1/1");
	assert.equal(on.cells.tool_loop.text, "n/a");
	assert.match(renderDetectabilityMarkdown(rows), /\| python\/x \(async, send_default_pii on\) \| 4 \|/);
	assert.match(renderDetectabilityHtml(rows), /failure detectability/);
	assert.equal(renderDetectabilityHtml([]), "");
});

test("false alarms on the healthy control are reported in the control column", () => {
	const rows = buildDetectabilityMatrix([
		variant("node/agents/y/framework=1", [
			result({ probeId: "agent.fault.control", callId: "agent.fault.control:blocking:0", failureClass: "dead_end", injected: false, verdict: "false_alarm", label: "healthy", reasons: [{ id: "false_alarm.dead_end", detail: "x" }] }),
		]),
	]);
	assert.equal(rows[0].cells.control.status, "false_alarm");
	assert.match(rows[0].cells.control.text, /false alarm on 1\/1 healthy run/);
});

test("Node AI data-collection mode splits rows and labels them", () => {
	const rows = buildDetectabilityMatrix([
		variant("node/agents/vercel/framework=7", [
			result({ genAIDataCollection: false, verdict: "undetectable", reasons: [{ id: "answer.missing", detail: "x" }] }),
			result({ genAIDataCollection: true }),
			result({}),
		]),
	]);
	assert.equal(rows.length, 3);
	const off = rows.find((row) => row.genAIDataCollection === false);
	assert.equal(off?.cells.truncated_answer.text, "not detectable 0/1 (answer.missing)");
	const markdown = renderDetectabilityMarkdown(rows);
	assert.match(markdown, /send_default_pii on, AI data collection off\) \| 1 \|/);
	assert.match(markdown, /send_default_pii on, AI data collection on\) \| 1 \|/);
	// Results without the field keep the old label.
	assert.match(markdown, /send_default_pii on\) \| 1 \|/);
});

test("failed control runs are excluded from the quiet count, never reported as healthy", () => {
	const control = (callId: string, label: string) =>
		result({ probeId: "agent.fault.control", callId, failureClass: "control", verdict: "not_applicable", label });
	const failedOnly = buildDetectabilityMatrix([
		variant("python/agents/x/framework=1", [control("agent.fault.control:blocking:0", "run_error:RateLimitError")]),
	])[0].cells.control;
	assert.equal(failedOnly.status, "not_applicable");
	assert.match(failedOnly.text, /no healthy control run: 1 failed control run\(s\) excluded \(run_error:RateLimitError\)/);
	const mixed = buildDetectabilityMatrix([
		variant("python/agents/x/framework=1", [
			control("agent.fault.control:blocking:0", "healthy"),
			control("agent.fault.control:streaming:0", "no_answer"),
		]),
	])[0].cells.control;
	assert.equal(mixed.status, "quiet");
	assert.equal(mixed.text, "quiet 1/1; 1 failed control run(s) excluded (no_answer)");
	// Negative control: an all-healthy control is unchanged.
	const healthy = buildDetectabilityMatrix([
		variant("python/agents/x/framework=1", [control("agent.fault.control:blocking:0", "healthy")]),
	])[0].cells.control;
	assert.equal(healthy.text, "quiet 1/1");
});
