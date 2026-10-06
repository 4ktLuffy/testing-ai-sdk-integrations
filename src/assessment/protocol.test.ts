import assert from "node:assert/strict";
import test from "node:test";
import { ASSESSMENT_EVENT_PREFIX, parseHarnessEvents } from "./protocol.js";

test("parses lifecycle events embedded in platform runner output", () => {
	const result = parseHarnessEvents(
		`[wrangler:info] ${ASSESSMENT_EVENT_PREFIX}{"type":"assessment_finished","timestamp":"2026-01-01T00:00:00.000Z"}`,
	);
	assert.equal(result.finished, true);
	assert.equal(result.failures.length, 0);
	assert.equal(result.events[0]?.type, "assessment_finished");
});

test("parses runtime failures emitted by the assessment harness", () => {
	const result = parseHarnessEvents(
		[
			`${ASSESSMENT_EVENT_PREFIX}{"type":"runtime_failure","failure":{"kind":"flush","message":"flush timed out","stopsVariant":true}}`,
			`${ASSESSMENT_EVENT_PREFIX}{"type":"assessment_finished"}`,
		].join("\n"),
	);

	assert.deepEqual(result.events[0], {
		type: "runtime_failure",
		failure: {
			kind: "flush",
			message: "flush timed out",
			probeId: undefined,
			stopsVariant: true,
		},
		timestamp: undefined,
	});
	assert.equal(result.failures.length, 0);
});

test("parses failure-injection run logs and rejects malformed ones", () => {
	const result = parseHarnessEvents(
		[
			`${ASSESSMENT_EVENT_PREFIX}{"type":"agent_log","probeId":"agent.fault.dead_end","callId":"agent.fault.dead_end:blocking:0","tools":[{"name":"search_docs","arguments":"{}"}],"error":{"type":"MaxTurnsExceeded","message":"Max turns (2) exceeded","stepLimit":true},"sendDefaultPii":false}`,
			`${ASSESSMENT_EVENT_PREFIX}{"type":"agent_log","probeId":"agent.fault.control","callId":"c","tools":[{"name":"lookup_order"}]}`,
			`${ASSESSMENT_EVENT_PREFIX}{"type":"assessment_finished"}`,
		].join("\n"),
	);
	assert.deepEqual(result.agentLogs, [
		{
			probeId: "agent.fault.dead_end",
			callId: "agent.fault.dead_end:blocking:0",
			tools: [{ name: "search_docs", arguments: "{}" }],
			error: { type: "MaxTurnsExceeded", message: "Max turns (2) exceeded", stepLimit: true },
			sendDefaultPii: false,
		},
	]);
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].kind, "protocol");
});

test("parses the Node AI data-collection mode and ignores non-boolean values", () => {
	const line = (mode: string) =>
		`${ASSESSMENT_EVENT_PREFIX}{"type":"agent_log","probeId":"agent.fault.control","callId":"c","tools":[],"answer":"ok","sendDefaultPii":true,"genAIDataCollection":${mode}}`;
	const result = parseHarnessEvents([line("false"), line('"false"')].join("\n"));
	assert.equal(result.agentLogs.length, 2);
	assert.equal(result.agentLogs[0].genAIDataCollection, false);
	assert.equal("genAIDataCollection" in result.agentLogs[1], false);
});
