import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { cassettePath, fingerprint, recordingIsComplete, templateClosure, readCassette, writeCassette, sanitizedUpstreams, requestMatch, type CassetteSpec } from "./cassette.js";
import type { ProviderExchange } from "./exchange.js";
import { ProviderRecorder } from "../span-collector/provider-recorder.js";
import { SpanCollector } from "../span-collector/server.js";
import { resolveVariants, type AssessmentTargetConfig } from "../assessment/matrix.js";
import { renderAssessmentProgram } from "../assessment/program-renderer.js";
import { deriveCompletion } from "../assessment/health.js";
import { summarizeProviderCalls } from "./truth.js";
import { assessmentEnvironment } from "../runner/execution.js";

const target: AssessmentTargetConfig = { platform: "python", category: "llm", framework: "openai", frameworkVersions: ["1"], sentryVersions: ["1", "2"], executionMode: "both", options: { apiStyle: ["chat", "responses"] } };
const request = { model: "m", messages: [{ role: "user", content: "hello" }] };
function exchange(overrides: Partial<ProviderExchange> = {}): ProviderExchange {
	return { sequence: 0, callId: "llm.baseline:blocking:0", upstream: "openrouter", method: "POST", path: "/chat/completions", status: 201,
		requestHeaders: {}, responseHeaders: { "content-type": "application/json" }, requestBody: JSON.stringify(request), responseBody: '{"text":"héllo"}', startedAt: "", finishedAt: "", ...overrides };
}
async function fixture(run: (spec: CassetteSpec) => Promise<void>) {
	const root = await mkdtemp(path.join(process.cwd(), ".cassette-test-"));
	try { await run({ file: path.join(root, "probe.jsonl"), header: { cassette: 1, probeFingerprint: fingerprint(request), templateHash: fingerprint("template"), recordedAt: "today", upstreams: sanitizedUpstreams({ openrouter: "http://user:secret@127.0.0.1:1/v1?key=secret" }) } }); }
	finally { await rm(root, { recursive: true, force: true }); }
}
async function replay(spec: CassetteSpec) {
	let forwarded = 0;
	const recorder = new ProviderRecorder(() => "run", { openrouter: "http://127.0.0.1:1" }, async () => { forwarded++; throw new Error("must not forward"); }, "replay");
	recorder.registerRun("run");
	await recorder.prepareReplay("run", { "llm.baseline": spec });
	const app = new Hono();
	app.post("/provider/:projectId/_call", (c) => recorder.handleCallMarker(c));
	app.all("/provider/:projectId/:upstream/*", (c) => recorder.handleProxy(c));
	await app.request("/provider/1/_call?id=llm.baseline:blocking:0&phase=start", { method: "POST" });
	return { recorder, app, forwarded: () => forwarded, send: (body = request) => app.request("/provider/1/openrouter/chat/completions?key=secret", { method: "POST", body: JSON.stringify(body) }) };
}

test("cassette keys exclude Sentry and execution mode; fingerprints track rendered calls", () => {
	const variants = resolveVariants(target);
	const first = variants[0];
	for (const variant of variants.filter((v) => v.identity.options.apiStyle === "chat")) {
		assert.equal(cassettePath("cassettes", variant, "llm.baseline"), cassettePath("cassettes", first, "llm.baseline"));
		assert.deepEqual(renderAssessmentProgram(target, variant).probeFingerprints, renderAssessmentProgram(target, first).probeFingerprints);
	}
	assert.notEqual(cassettePath("cassettes", first, "llm.baseline"), cassettePath("cassettes", variants[1], "llm.baseline"));
	assert.notDeepEqual(renderAssessmentProgram(target, first).probeFingerprints, renderAssessmentProgram(target, { ...first, modelOverrides: { request: "changed" } }).probeFingerprints);
	assert.match(cassettePath("cassettes", first, "llm.baseline"), /python\/llm\/openai\/framework=1;apiStyle=chat\/llm.baseline.jsonl$/);
});

test("canonical request invariants fail closed while defaults produce drift", () => {
	const base = exchange();
	assert.equal(requestMatch(base, exchange()), "match");
	for (const body of [{ ...request, model: "other" }, { ...request, stream: true }, { ...request, messages: [] }, { ...request, tools: [{ function: { name: "tool" } }] }]) {
		assert.equal(requestMatch(base, exchange({ requestBody: JSON.stringify(body) })), "mismatch");
	}
	assert.equal(requestMatch(base, exchange({ method: "GET" })), "mismatch");
	assert.equal(requestMatch(base, exchange({ path: "/responses" })), "mismatch");
	assert.equal(requestMatch(base, exchange({ requestBody: JSON.stringify({ ...request, temperature: 1 }) })), "drift");
});

for (const streaming of [false, true]) test(`replay preserves ${streaming ? "stream chunks" : "JSON bytes"}, status and content type without forwarding`, async () => {
	await fixture(async (spec) => {
		const chunks = streaming ? ["data: héllo\r\n\r\n", "data: [DONE]\n\n"] : ['{"text":"héllo"}'];
		const stored = exchange({ responseBody: chunks.join(""), responseChunks: chunks.map((c) => Buffer.from(c).toString("base64")), responseHeaders: { "content-type": streaming ? "text/event-stream" : "application/json" } });
		await writeCassette(spec, [stored]);
		const context = await replay(spec);
		const response = await context.send();
		assert.equal(response.status, 201);
		assert.equal(response.headers.get("content-type"), stored.responseHeaders["content-type"]);
		const reader = response.body!.getReader();
		for (const chunk of chunks) assert.deepEqual(Buffer.from((await reader.read()).value!), Buffer.from(chunk));
		assert.equal((await reader.read()).done, true);
		assert.equal(context.forwarded(), 0);
		assert.equal(context.recorder.getExchanges("run")[0].responseBody, stored.responseBody);
		assert.equal((await context.send()).status, 599);
		assert.equal(context.recorder.getFailures("run")[0].kind, "provider");
	});
});

test("missing cassette and model mismatch return 599 and stopping provider failures", async () => {
	await fixture(async (spec) => {
		let context = await replay(spec);
		assert.equal((await context.send()).status, 599);
		assert.equal(context.recorder.getFailures("run")[0].stopsVariant, true);
		assert.equal(deriveCompletion(context.recorder.getFailures("run")), "incomplete");
		await writeCassette(spec, [exchange()]);
		context = await replay(spec);
		assert.equal((await context.send({ ...request, model: "changed" })).status, 599);
		assert.equal(context.forwarded(), 0);
	});
});

test("unrelated parameter is served with a non-stopping drift note", async () => {
	await fixture(async (spec) => {
		await writeCassette(spec, [exchange()]);
		const context = await replay(spec);
		assert.equal((await context.send({ ...request, temperature: 1 } as typeof request)).status, 201);
		assert.deepEqual(context.recorder.getFailures("run").map((f) => [f.kind, f.stopsVariant]), [["provider_cassette_drift", false]]);
		assert.equal(deriveCompletion(context.recorder.getFailures("run")), "complete");
		const control = await replay(spec);
		await control.send();
		assert.deepEqual(control.recorder.getFailures("run"), []);
	});
});

test("stale fingerprints and template hashes produce setup failures and never serve", async () => {
	await fixture(async (spec) => {
		await writeCassette(spec, [exchange()]);
		assert.ok(await readCassette(spec));
		for (const field of ["probeFingerprint", "templateHash"] as const) {
			const context = await replay({ ...spec, header: { ...spec.header, [field]: "changed" } });
			assert.equal(context.recorder.getFailures("run")[0].kind, "setup");
			assert.match(context.recorder.getFailures("run")[0].message, /cassette is stale, re-record/);
			assert.equal((await context.send()).status, 599);
		}
	});
});

test("cassette contains no credentials from headers, query or upstream URLs", async () => {
	await fixture(async (spec) => {
		const unsafe = exchange({ path: "/chat/completions?key=secret&alt=sse", requestHeaders: { authorization: "secret", "x-api-key": "secret", "x-goog-api-key": "secret", "content-type": "application/json" } });
		assert.match(JSON.stringify(unsafe), /secret/);
		await writeCassette(spec, [unsafe]);
		const raw = await readFile(spec.file, "utf8");
		assert.doesNotMatch(raw, /secret|authorization|x-api-key|x-goog-api-key|key=/);
		assert.match(raw, /alt=sse/);
	});
});

test("replay environment overrides real keys; off leaves environment untouched", () => {
	const collector = new SpanCollector(0, { providerTruth: "replay" });
	const environment = assessmentEnvironment({ sentryDsn: "dsn", environment: collector.getProviderEnvironment("run") });
	for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENAI_API_KEY", "ANTHROPIC_API_KEY"]) assert.equal(environment[key], "replay-dummy");
	assert.deepEqual(new SpanCollector().getProviderEnvironment("run"), {});
});

test("localhost replay works with unreachable upstream and reports exhaustion", async () => {
	await fixture(async (spec) => {
		await writeCassette(spec, [exchange()]);
		const collector = new SpanCollector(0, { providerTruth: "replay", providerUpstreams: { openrouter: "http://127.0.0.1:1" } });
		await collector.start();
		try {
			collector.registerRun("run");
			await collector.prepareReplay("run", { "llm.baseline": spec });
			const env = collector.getProviderEnvironment("run");
			await fetch(`${env.SENTRY_ASSESSMENT_PROVIDER_TRUTH_URL}/_call?id=llm.baseline:blocking:0&phase=start`, { method: "POST" });
			const send = () => fetch(`${env.SENTRY_ASSESSMENT_OPENROUTER_BASE}/chat/completions`, { method: "POST", body: JSON.stringify(request) });
			assert.equal((await send()).status, 201);
			assert.equal((await send()).status, 599);
			assert.equal(collector.getFailures("run")[0].kind, "provider");
		} finally { await collector.stop(); }
	});
});


test("replay sequences are per call and provider summaries remain identical", async () => {
	await fixture(async (spec) => {
		const first = exchange({ sequence: 5, responseBody: '{"id":"first","model":"m","usage":{"prompt_tokens":3}}' });
		const second = exchange({ sequence: 9, responseBody: '{"id":"second","model":"m"}' });
		const other = exchange({ sequence: 1, callId: "llm.baseline:streaming:0", responseBody: '{"id":"other"}' });
		await writeCassette(spec, [second, other, first]);
		const context = await replay(spec);
		assert.equal(await (await context.send()).text(), first.responseBody);
		await context.app.request("/provider/1/_call?id=llm.baseline:streaming:0&phase=start", { method: "POST" });
		assert.equal(await (await context.send()).text(), other.responseBody);
		await context.app.request("/provider/1/_call?id=llm.baseline:blocking:0&phase=start", { method: "POST" });
		assert.equal(await (await context.send()).text(), second.responseBody);
		const actual = summarizeProviderCalls(context.recorder.getExchanges("run"));
		const expected = summarizeProviderCalls([first, other, second].map((item, sequence) => ({ ...item, sequence })));
		assert.deepEqual(actual, expected);
		assert.equal((await context.send()).status, 599);
	});
});

test("recording to cassette and replay preserves raw bytes and redacts wire credentials", async () => {
	await fixture(async (spec) => {
		const bytes = [Buffer.from([0xff, 0x00]), Buffer.from("data: héllo\n\n")];
		let forwarded = false;
		const recorder = new ProviderRecorder(() => "run", { openrouter: "http://127.0.0.1:1" }, async (url, init) => {
			assert.match(String(url), /key=wire-secret/);
			assert.equal(new Headers(init?.headers).get("authorization"), "wire-secret");
			forwarded = true;
			return new Response(new ReadableStream({ start(controller) {
				for (const chunk of bytes) controller.enqueue(chunk);
				controller.close();
			} }), { status: 202, headers: { "content-type": "text/event-stream" } });
		});
		recorder.registerRun("run");
		const app = new Hono();
		app.post("/provider/:projectId/_call", (c) => recorder.handleCallMarker(c));
		app.all("/provider/:projectId/:upstream/*", (c) => recorder.handleProxy(c));
		await app.request("/provider/1/_call?id=llm.baseline:blocking:0&phase=start", { method: "POST" });
		await (await app.request("/provider/1/openrouter/chat/completions?key=wire-secret", { method: "POST", headers: { authorization: "wire-secret" }, body: JSON.stringify(request) })).arrayBuffer();
		assert.equal(await recorder.settle("run"), true);
		assert.equal(forwarded, true);
		await writeCassette(spec, recorder.getExchanges("run"));
		assert.doesNotMatch(await readFile(spec.file, "utf8"), /wire-secret|authorization|key=/);
		const context = await replay(spec);
		const response = await context.send();
		assert.equal(response.status, 202);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat(bytes));
		assert.equal(context.forwarded(), 0);
	});
});

test("a recording replaces a cassette only when every call finished and ended in success", () => {
	const ok = exchange();
	assert.equal(recordingIsComplete([ok], true), true);
	// Retried attempts are kept: the call still ended in a success.
	assert.equal(recordingIsComplete([exchange({ sequence: 0, status: 429 }), exchange({ sequence: 1 })], true), true);
	// Negative controls: each of these used to be written over a good cassette.
	assert.equal(recordingIsComplete([ok], false), false, "recordings still draining");
	assert.equal(recordingIsComplete([exchange({ status: 503 })], true), false, "call ended in a failure");
	assert.equal(recordingIsComplete([exchange({ sequence: 0 }), exchange({ sequence: 1, status: 429 })], true), false, "last attempt throttled");
	assert.equal(recordingIsComplete([exchange({ error: "boom" })], true), false);
	assert.equal(recordingIsComplete([exchange({ callId: undefined })], true), false);
	assert.equal(recordingIsComplete([], true), false);
});

test("replay matching treats roles and response continuation as wire invariants", () => {
	const base = exchange();
	const swapped = { ...request, messages: [{ role: "assistant", content: "hello" }] };
	assert.equal(requestMatch(base, exchange({ requestBody: JSON.stringify(swapped) })), "mismatch");
	const responses = exchange({ path: "/responses", requestBody: JSON.stringify({ model: "m", input: [{ role: "user", content: "hi" }] }) });
	const chained = exchange({ path: "/responses", requestBody: JSON.stringify({ model: "m", input: [{ role: "user", content: "hi" }], previous_response_id: "resp_1" }) });
	assert.equal(requestMatch(responses, chained), "mismatch");
	assert.equal(requestMatch(chained, chained), "match");
	// Same roles, different text stays drift.
	assert.equal(requestMatch(base, exchange({ requestBody: JSON.stringify({ ...request, messages: [{ role: "user", content: "bye" }] }) })), "drift");
});

test("replay serves retry-controlling headers from the cassette", async () => {
	await fixture(async (spec) => {
		const stored = exchange({ status: 429, responseHeaders: { "content-type": "application/json", "x-should-retry": "false", "retry-after": "7" } });
		await writeCassette(spec, [stored, exchange({ sequence: 1 })]);
		const response = await (await replay(spec)).send();
		assert.equal(response.status, 429);
		assert.equal(response.headers.get("x-should-retry"), "false");
		assert.equal(response.headers.get("retry-after"), "7");
	});
});

test("template fingerprint covers inherited base and shared templates, not unrelated ones", async () => {
	const root = await mkdtemp(path.join(process.cwd(), ".template-test-"));
	try {
		await mkdir(path.join(root, "shared"), { recursive: true });
		await mkdir(path.join(root, "llm"), { recursive: true });
		await writeFile(path.join(root, "base.node.njk"), "base v1");
		await writeFile(path.join(root, "shared", "helper.njk"), "helper v1");
		await writeFile(path.join(root, "unrelated.njk"), "unrelated v1");
		await writeFile(path.join(root, "llm", "leaf.njk"), '{% extends "base.node.njk" %}{% include "shared/helper.njk" %}');
		await writeFile(path.join(root, "llm", "dynamic.njk"), "{% extends baseTemplate %}");
		const leaf = () => templateClosure(root, "llm/leaf.njk");
		const dynamic = () => templateClosure(root, "llm/dynamic.njk");
		const [leaf1, dynamic1] = [await leaf(), await dynamic()];
		await writeFile(path.join(root, "unrelated.njk"), "unrelated v2");
		assert.equal(await leaf(), leaf1);
		await writeFile(path.join(root, "base.node.njk"), "base v2");
		assert.notEqual(fingerprint(await leaf()), fingerprint(leaf1), "edited base template must invalidate");
		assert.notEqual(fingerprint(await dynamic()), fingerprint(dynamic1), "dynamic extends must invalidate on any base edit");
		const leaf2 = await leaf();
		await writeFile(path.join(root, "shared", "helper.njk"), "helper v2");
		assert.notEqual(await leaf(), leaf2, "edited shared template must invalidate");
	} finally { await rm(root, { recursive: true, force: true }); }
});
