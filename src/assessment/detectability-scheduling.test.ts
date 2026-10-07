import assert from "node:assert/strict";
import test from "node:test";
import { detectabilityApplies } from "./catalog.js";
import { resolveVariants, type AssessmentTargetConfig } from "./matrix.js";
import { renderAssessmentProgram } from "./program-renderer.js";

const target: AssessmentTargetConfig = {
	platform: "node",
	category: "agents",
	framework: "vercel",
	frameworkVersions: ["7"],
	sentryVersions: ["11"],
	options: { provider: ["openai", "anthropic"] },
};

function faultProbes(provider: string): string[] {
	const variant = resolveVariants(target).find((entry) => entry.identity.options.provider === provider)!;
	const rendered = renderAssessmentProgram(target, variant, undefined, { detectability: true });
	return Object.keys(rendered.probeCallModes).filter((id) => id.startsWith("agent.fault."));
}

test("fault probes are scheduled for variants that implement faults, not Anthropic ones", () => {
	assert.equal(faultProbes("openai").length, 6);
	assert.deepEqual(faultProbes("anthropic"), []);
	assert.equal(detectabilityApplies("node", true, { provider: "anthropic" }), false);
	// Negative control: same inputs without the provider option are unchanged.
	assert.equal(detectabilityApplies("node", true), true);
	assert.equal(detectabilityApplies("python", true, { provider: "openai" }), true);
});
