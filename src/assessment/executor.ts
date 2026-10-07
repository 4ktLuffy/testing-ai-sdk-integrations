import { fileURLToPath } from "node:url";
import { cassettePath, fingerprint, recordingIsComplete, sanitizedUpstreams, templateClosure, writeCassette, type CassetteSpec, type ProviderTruthMode } from "../provider/cassette.js";
import { providerUpstreamsFromEnvironment } from "../span-collector/provider-recorder.js";
import { renderAssessmentProgram } from "./program-renderer.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getProbeCatalog } from "./catalog.js";
import { toAssessmentTargetConfig } from "./discovery.js";
import {
	resolveInstalledPackageVersion,
	resolveInstalledSentryVersion,
} from "./installed-version.js";
import type { ResolvedVariant } from "./matrix.js";
import { partitionSpansByProbe } from "./partition.js";
import { writeAssessmentProgram } from "./program-files.js";
import { parseHarnessEvents } from "./protocol.js";
import { reconcileExecution } from "./reconciliation.js";
import type {
	ProbeResult,
	ProviderCallSummary,
	RuntimeFailure,
	VariantAssessment,
} from "./types.js";
import { evaluateVariant } from "./variant-evaluation.js";
import { CloudflareRunner } from "../runner/cloudflare-runner.js";
import { JavaScriptRunner } from "../runner/javascript-runner.js";
import { PythonRunner } from "../runner/python-runner.js";
import type { AssessmentRunner } from "../runner/execution.js";
import type { DiscoveredFramework } from "../runner/framework-discovery.js";
import {
	resolveFrameworkDependencies,
	type ResolvedFramework,
} from "../runner/framework-config.js";
import type { SpanCollector } from "../span-collector/server.js";
import { summarizeProviderCalls } from "../provider/truth.js";

function runnerFramework(
	framework: DiscoveredFramework,
	variant: ResolvedVariant,
): ResolvedFramework {
	return {
		name: framework.name,
		platform: framework.platform,
		version: variant.identity.frameworkVersion,
		sentryVersion: variant.identity.sentryVersion,
		dependencies: resolveFrameworkDependencies(
			framework,
			variant.identity.frameworkVersion,
		),
		minimumPlatformVersion: framework.minimumPlatformVersion,
	};
}

function initialProbes(
	framework: DiscoveredFramework,
	probeIds?: ReadonlySet<string>,
): ProbeResult[] {
	return getProbeCatalog(framework.category as "llm" | "agents").flatMap(
		(probe) => {
			if (probeIds && !probeIds.has(probe.id)) return [];
			return [
				{
					probeId: probe.id,
					status: "pending",
					callModes: [],
					traceIds: [],
					spanIds: [],
				},
			];
		},
	);
}

function runtimeFailure(
	kind: RuntimeFailure["kind"],
	message: string,
	stopsVariant = true,
): RuntimeFailure {
	return { kind, message, stopsVariant };
}

function isRuntimeFailure(error: unknown): error is RuntimeFailure {
	return (
		typeof error === "object" &&
		error !== null &&
		"kind" in error &&
		"message" in error &&
		"stopsVariant" in error &&
		typeof error.kind === "string" &&
		typeof error.message === "string" &&
		typeof error.stopsVariant === "boolean"
	);
}

/** Executes a rendered assessment and converts runtime evidence to a variant assessment. */
export class AssessmentExecutor {
	private readonly cloudflareRunner = new CloudflareRunner();
	private readonly javascriptRunner = new JavaScriptRunner();
	private readonly pythonRunner = new PythonRunner();

	constructor(private readonly collector: SpanCollector) {}

	private runnerFor(
		platform: DiscoveredFramework["platform"],
	): AssessmentRunner {
		if (platform === "cloudflare") return this.cloudflareRunner;
		if (platform === "python") return this.pythonRunner;
		return this.javascriptRunner;
	}

	async execute(
		framework: DiscoveredFramework,
		variant: ResolvedVariant,
		options: { probeIds?: ReadonlySet<string>; providerTruth?: ProviderTruthMode; cassetteRoot?: string } = {},
	): Promise<VariantAssessment> {
		const probes = initialProbes(framework, options.probeIds);
		const failures: RuntimeFailure[] = [];
		let generatedProgramPath: string | undefined;
		let logPath: string | undefined;
		let spans: VariantAssessment["spans"] = [];
		let resolvedFrameworkVersion: string | undefined;
		let resolvedSentryVersion: string | undefined;
		let providerCalls: ProviderCallSummary[] | undefined;

		try {
			const target = toAssessmentTargetConfig(framework);
			if (options.providerTruth === "replay" && (framework.category !== "llm" || !["openai", "anthropic", "google-genai"].includes(framework.name))) {
				throw runtimeFailure("setup", "Replay requires a target with provider-routing hooks.");
			}
			const generated = await writeAssessmentProgram(target, variant, {
				probeIds: options.probeIds,
				providerTruth: !!options.providerTruth,
			});
			generatedProgramPath = generated.programPath;
			logPath = generated.logPath;
			for (const probe of probes) {
				probe.callModes = generated.probeCallModes[probe.probeId] ?? [];
			}
			const workDir = path.dirname(generated.programPath);
			const executionFramework = runnerFramework(framework, variant);
			const specs: Record<string, CassetteSpec> = {};
			if (options.providerTruth) {
				const rendered = renderAssessmentProgram(target, variant, options.probeIds);
				const template = await templateClosure(fileURLToPath(new URL("../runner/templates/", import.meta.url)), rendered.templatePath);
				for (const [probeId, probeFingerprint] of Object.entries(rendered.probeFingerprints)) {
					specs[probeId] = { file: cassettePath(options.cassetteRoot ?? "cassettes", variant, probeId), header: {
						cassette: 1, probeFingerprint, templateHash: fingerprint(template), recordedAt: new Date().toISOString(),
						upstreams: sanitizedUpstreams(providerUpstreamsFromEnvironment()),
					} };
				}
			}
			this.collector.registerRun(variant.id);
			if (options.providerTruth === "replay") {
				await this.collector.prepareReplay(variant.id, specs);
				const stale = this.collector.getFailures(variant.id);
				if (stale.length) {
					failures.push(...stale.slice(1));
					throw stale[0];
				}
			}

			const executionContext = {
				workDir,
				sentryDsn: this.collector.getDsn(variant.id),
				programPath: generated.programPath,
				logPath: generated.logPath,
				timeoutMs:
					framework.executionTimeoutMs ??
					(framework.platform === "cloudflare" ? 300_000 : 120_000),
				environment: options.providerTruth
					? this.collector.getProviderEnvironment(variant.id)
					: undefined,
			};
			const runner = this.runnerFor(framework.platform);
			const environmentContext = {
				workDir,
				framework: executionFramework,
			};
			if (await runner.needsSetup(environmentContext)) {
				await runner.setupEnvironment(environmentContext);
			}
			const frameworkPackage = executionFramework.dependencies.find(
				(dependency) => dependency.version === "framework",
			)?.package;
			if (frameworkPackage) {
				resolvedFrameworkVersion = await resolveInstalledPackageVersion(
					workDir,
					framework.platform,
					frameworkPackage,
				);
			}
			resolvedSentryVersion = await resolveInstalledSentryVersion(
				workDir,
				framework.platform,
			);
			const execution = await runner.executeAssessmentProgram(executionContext);
			const protocol = parseHarnessEvents(
				`${execution.stdout}\n${execution.stderr}`,
			);
			failures.push(...reconcileExecution(probes, execution, protocol));

			await new Promise((resolve) => setTimeout(resolve, 250));
			spans = this.collector.getSpans(variant.id);
			const collectorFailures = this.collector.getFailures(variant.id);
			failures.push(...collectorFailures);
			if (options.providerTruth) {
				const recorded = await this.recordProviderTruth(variant.id, workDir);
				providerCalls = recorded.calls;
				failures.push(...recorded.failures);
				if (options.providerTruth !== "replay" && !failures.some((failure) => failure.stopsVariant)) {
					const exchanges = this.collector.getProviderExchanges(variant.id);
					for (const [probeId, spec] of Object.entries(specs)) {
						const selected = exchanges.filter((exchange) => exchange.callId?.split(":", 1)[0] === probeId);
						if (recordingIsComplete(selected, recorded.settled)) await writeCassette(spec, selected);
					}
				}
			}
			const partition = partitionSpansByProbe(spans);
			for (const probe of probes) {
				const probeSpans = partition.byProbe.get(probe.probeId) ?? [];
				probe.spanIds = probeSpans.map((span) => span.span_id);
				probe.traceIds = [...new Set(probeSpans.map((span) => span.trace_id))];
			}
		} catch (error) {
			if (isRuntimeFailure(error)) {
				failures.push(error);
			} else {
				failures.push(
					runtimeFailure(
						generatedProgramPath ? "setup" : "render",
						error instanceof Error ? error.message : String(error),
					),
				);
			}
		}

		return evaluateVariant({
			variant,
			category: framework.category,
			probes,
			spans,
			runtimeFailures: failures,
			resolvedFrameworkVersion,
			resolvedSentryVersion,
			generatedProgramPath,
			logPath,
			providerCalls,
		});
	}

	/**
	 * Persist recorded provider exchanges next to the generated program and
	 * summarize them per assessment call. Recording gaps are reported, never
	 * dropped, but do not stop the variant: span evaluation is still valid.
	 */
	private async recordProviderTruth(
		runId: string,
		workDir: string,
	): Promise<{ calls: ProviderCallSummary[]; failures: RuntimeFailure[]; settled: boolean }> {
		const failures: RuntimeFailure[] = [];
		const settled = await this.collector.settleProviderExchanges(runId);
		if (!settled) {
			failures.push(
				runtimeFailure(
					"collector",
					"Provider exchange recording did not finish in time.",
					false,
				),
			);
		}
		const exchanges = this.collector.getProviderExchanges(runId);
		await writeFile(
			path.join(workDir, "provider-exchanges.jsonl"),
			exchanges.map((exchange) => `${JSON.stringify(exchange)}\n`).join(""),
			"utf8",
		);
		const { calls, unattributed } = summarizeProviderCalls(exchanges);
		if (unattributed.length > 0) {
			failures.push(
				runtimeFailure(
					"collector",
					`${unattributed.length} provider exchange(s) were recorded outside an assessment call.`,
					false,
				),
			);
		}
		return { calls, failures, settled };
	}
}
