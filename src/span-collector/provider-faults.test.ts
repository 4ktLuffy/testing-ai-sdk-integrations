import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { summarizeProviderCalls } from "../provider/truth.js";
import { SpanCollector } from "./server.js";

async function withFaultRecorder(
	allowFaults: boolean,
	run: (context: {
		collector: SpanCollector;
		upstreamRequests: () => number;
		runId: string;
		base: string;
		marker: string;
	}) => Promise<void>,
): Promise<void> {
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			requests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					id: "chatcmpl-ok",
					model: "upstream-model",
					choices: [{ finish_reason: "stop", message: { content: "ok" } }],
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const collector = new SpanCollector(0, {
		providerTruth: true,
		providerFaults: allowFaults,
		providerUpstreams: { openrouter: `http://127.0.0.1:${port}/v1` },
	});
	await collector.start();
	try {
		const runId = "provider-fault-test";
		collector.getDsn(runId);
		collector.registerRun(runId);
		const environment = collector.getProviderEnvironment(runId);
		await run({
			collector,
			upstreamRequests: () => requests,
			runId,
			base: environment.SENTRY_ASSESSMENT_OPENROUTER_BASE,
			marker: environment.SENTRY_ASSESSMENT_PROVIDER_TRUTH_URL,
		});
	} finally {
		await collector.stop();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

function marker(base: string, query: Record<string, string>) {
	return fetch(`${base}/_call?${new URLSearchParams(query)}`, { method: "POST" });
}

function chat(base: string) {
	return fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer sk-fault-test-secret" },
		body: JSON.stringify({ model: "m", messages: [] }),
	});
}

test("provider_500x3 serves three recorded 500s, then reaches the upstream", async () => {
	await withFaultRecorder(true, async ({ collector, upstreamRequests, runId, base, marker: url }) => {
		const callId = "agent.fault.retry_storm:blocking:0";
		assert.equal((await marker(url, { id: callId, phase: "start", fault: "provider_500x3" })).status, 200);
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const response = await chat(base);
			statuses.push(response.status);
			await response.text();
		}
		assert.equal((await marker(url, { id: callId, phase: "end" })).status, 200);
		assert.deepEqual(statuses, [500, 500, 500, 200]);
		assert.equal(upstreamRequests(), 1);
		assert.equal(await collector.settleProviderExchanges(runId), true);

		const exchanges = collector.getProviderExchanges(runId);
		assert.deepEqual(
			exchanges.map((exchange) => [exchange.status, exchange.injectedFault]),
			[[500, "provider_500x3"], [500, "provider_500x3"], [500, "provider_500x3"], [200, undefined]],
		);
		assert.ok(!JSON.stringify(exchanges).includes("sk-fault-test-secret"));
		const { calls } = summarizeProviderCalls(exchanges);
		assert.equal(calls[0].exchanges.filter((exchange) => exchange.injectedFault).length, 3);

		// The fault is scoped to its call: the next call reaches the upstream directly.
		await marker(url, { id: "agent.fault.control:blocking:0", phase: "start" });
		assert.equal((await chat(base)).status, 200);
		await marker(url, { id: "agent.fault.control:blocking:0", phase: "end" });
	});
});

test("provider faults are refused unless the recorder allows them", async () => {
	await withFaultRecorder(false, async ({ upstreamRequests, base, marker: url }) => {
		const refused = await marker(url, { id: "x:blocking:0", phase: "start", fault: "provider_500x3" });
		assert.equal(refused.status, 400);
		assert.equal((await chat(base)).status, 200);
		assert.equal(upstreamRequests(), 1);
	});
	await withFaultRecorder(true, async ({ base, marker: url }) => {
		const unknown = await marker(url, { id: "x:blocking:0", phase: "start", fault: "made_up" });
		assert.equal(unknown.status, 400);
		assert.equal((await chat(base)).status, 200);
	});
});
