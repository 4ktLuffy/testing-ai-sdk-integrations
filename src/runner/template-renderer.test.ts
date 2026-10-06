import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplate } from "./template-renderer.js";

test("renders LiteLLM with its explicit Sentry integration", () => {
	const program = renderTemplate("llm/python/litellm/assessment.njk", {
		targetId: "python/llm/litellm",
		variantId: "variant",
		probes: [],
		provider: "openai",
		apiStyle: "completion",
		isAsync: false,
	});

	const integrationImport = program.indexOf(
		"from sentry_sdk.integrations.litellm import LiteLLMIntegration",
	);
	assert.ok(integrationImport >= 0);
	assert.ok(integrationImport < program.indexOf("sentry_sdk.init("));
	assert.match(
		program,
		/integrations=\[LiteLLMIntegration\(include_prompts=True\)\]/,
	);
	assert.match(program, /disabled_integrations=\[OpenAIIntegration\(\)\]/);
	assert.match(program, /finally:\n\s+await asyncio\.sleep\(0\.1\)/);
});

for (const [template, isAsync] of [
	["llm/node/openai/assessment.njk", false],
	["llm/nextjs/openai/assessment.njk", false],
	["llm/cloudflare/openai/assessment.njk", false],
	["llm/python/openai/assessment.njk", true],
] as const) {
	test(`renders provider-truth hooks for ${template} only when enabled`, () => {
		const context = {
			targetId: "target",
			variantId: "variant",
			probes: [],
			apiStyle: "chat",
			isAsync,
		};
		const off = renderTemplate(template, context);
		const on = renderTemplate(template, { ...context, providerTruth: true });
		for (const marker of [
			"SENTRY_ASSESSMENT_OPENROUTER_BASE",
			"SENTRY_ASSESSMENT_PROVIDER_TRUTH_URL",
			"phase",
		]) {
			assert.equal(off.includes(marker), false, `${marker} rendered when off`);
			assert.ok(on.includes(marker), `${marker} missing when on`);
		}
		assert.ok(off.includes('"https://openrouter.ai/api/v1"'));
		assert.ok(on.includes('"https://openrouter.ai/api/v1"'));
		if (!template.includes("/python/")) {
			assert.ok(on.includes("Sentry.suppressTracing("));
		}
	});
}

for (const platform of ["node", "nextjs", "cloudflare", "python"]) {
	for (const framework of ["anthropic", "google-genai"]) {
		test(`renders ${platform}/${framework} provider base only when enabled`, () => {
			const template = `llm/${platform}/${framework}/assessment.njk`;
			const context = { targetId: "target", variantId: "variant", probes: [], isAsync: true };
			const marker = framework === "anthropic" ? "SENTRY_ASSESSMENT_OPENROUTER_BASE" : "SENTRY_ASSESSMENT_GOOGLE_BASE";
			const off = renderTemplate(template, context);
			const on = renderTemplate(template, { ...context, providerTruth: true });
			assert.equal(off.includes(marker), false);
			assert.ok(on.includes(marker));
			if (framework === "google-genai") {
				assert.ok(on.includes(platform === "python" ? 'http_options={"base_url":' : "httpOptions: { baseUrl:"));
			} else {
				assert.ok(on.includes('"https://openrouter.ai/api"'));
			}
		});
	}
}

for (const [template, extra] of [
	["agents/python/openai-agents/assessment.njk", { isAsync: true }],
	["agents/python/pydantic-ai/assessment.njk", { isAsync: true, modelSetup: "single" }],
	["agents/python/langgraph/assessment.njk", { isAsync: false, provider: "openai" }],
	["agents/node/langgraph/assessment.njk", { provider: "openai" }],
	["agents/node/vercel/assessment.njk", { provider: "openai", agentStyle: "class", platform: "node", baseTemplate: "base.node.assessment.njk" }],
] as const) {
	test(`renders failure injection for ${template} only when enabled`, () => {
		const context = { targetId: "target", variantId: "variant", probes: [], ...extra };
		const off = renderTemplate(template, { ...context, providerTruth: true });
		const on = renderTemplate(template, { ...context, providerTruth: true, detectability: true });
		for (const marker of ["agent_log", "FAULT_PROBE_PREFIX", "SENTRY_ASSESSMENT_SEND_DEFAULT_PII", "providerFault"]) {
			assert.equal(off.includes(marker), false, `${marker} rendered when off`);
			assert.ok(on.includes(marker), `${marker} missing when on`);
		}
		assert.match(on, /run_fault_call|runFaultCall = async/);
		assert.match(on, /SENTRY_ASSESSMENT_OPENROUTER_BASE/);
	});
}
