export interface CapturedSpan {
	span_id: string;
	trace_id: string;
	op: string;
	description?: string;
	start_timestamp: number;
	timestamp: number;
	data?: Record<string, unknown>;
	tags?: Record<string, unknown>;
	[key: string]: unknown;
}

export type AssessmentPlatform = "node" | "python" | "nextjs" | "cloudflare";
export type AssessmentCategory = "llm" | "agents";
export type FindingSeverity = "critical" | "major" | "minor" | "info";
export type AssessmentCompletion = "complete" | "incomplete";
export type AssessmentRating =
	| "all_good"
	| "improvements_needed"
	| "significant_improvements_needed"
	| "out_of_spec";
export type AssessmentHealth =
	| "healthy"
	| "healthy_with_notes"
	| "degraded"
	| "broken";
export type ProbeStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "blocked";
export type CapabilityState =
	| "healthy"
	| "legacy"
	| "malformed"
	| "missing"
	| "blocked";
export interface TargetIdentity {
	platform: AssessmentPlatform;
	category: AssessmentCategory;
	framework: string;
}

export interface VariantIdentity {
	frameworkVersion: string;
	sentryVersion: string;
	executionMode?: "sync" | "async";
	options: Record<string, string>;
}

export interface Evidence {
	spanId?: string;
	traceId?: string;
	attribute?: string;
	value?: unknown;
	description?: string;
}

export interface RuntimeFailure {
	kind:
		| "setup"
		| "render"
		| "process_start"
		| "process_exit"
		| "timeout"
		| "provider"
		| "collector"
		| "flush"
		| "protocol";
	message: string;
	probeId?: string;
	stopsVariant: boolean;
}

export interface ProbeResult {
	probeId: string;
	status: ProbeStatus;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	runtimeError?: RuntimeFailure;
	callModes: Array<"blocking" | "streaming">;
	traceIds: string[];
	spanIds: string[];
}

export interface Observation {
	observationId: string;
	capability: string;
	state: CapabilityState;
	probeId: string;
	variantId: string;
	source?: "modern" | "legacy";
	expected?: unknown;
	actual?: unknown;
	evidence: Evidence[];
}

export interface FindingOccurrence {
	variantId: string;
	probeId: string;
	observationIds: string[];
	evidence: Evidence[];
}

export interface Finding {
	findingId: string;
	capability: string;
	severity: FindingSeverity;
	title: string;
	description: string;
	remediation?: string;
	occurrences: FindingOccurrence[];
}

/** Usage as the provider reported it. Unreported fields stay undefined. */
export interface ProviderUsage {
	input?: number;
	output?: number;
	total?: number;
	cached?: number;
	cacheWrite?: number;
	reasoning?: number;
}

/** One recorded provider HTTP exchange, normalized to what the provider reported. */
export interface ProviderExchangeSummary {
	sequence: number;
	path: string;
	status: number;
	api?: "chat" | "responses" | "messages" | "generateContent";
	streaming?: boolean;
	usage?: ProviderUsage;
	model?: string;
	responseId?: string;
	finishReason?: string;
	terminalEvent?: string;
	/** Responses API `incomplete_details.reason`, e.g. max_output_tokens. */
	incompleteReason?: string;
	/** The response asked for tool calls. */
	toolCalls?: boolean;
	/** Set when the recorder served a scripted fault instead of the upstream. */
	injectedFault?: string;
}

/**
 * What an assessment program observed during one failure-injection call, from
 * its own bookkeeping: the tools it ran, the answer it got, and how the run
 * ended. This, plus recorded provider exchanges, is the ground truth for
 * detectability; Sentry spans are never used to label a run.
 */
export interface AgentRunLog {
	probeId: string;
	callId: string;
	tools: Array<{ name: string; arguments: string }>;
	/** Final answer text; undefined when the run produced none. */
	answer?: string;
	/** The run raised; `stepLimit` marks the framework's own step/turn limit. */
	error?: { type: string; message: string; stepLimit?: boolean };
	/** Whether the program sent default PII (prompts, tool I/O) to Sentry. */
	sendDefaultPii?: boolean;
	/**
	 * Node only: whether `dataCollection.genAI` inputs/outputs were left on.
	 * In @sentry/node 11 this, not sendDefaultPii, gates AI inputs and outputs.
	 */
	genAIDataCollection?: boolean;
}

export type DetectabilityVerdict =
	| "detectable"
	| "undetectable"
	| "false_alarm"
	| "not_triggered"
	| "not_applicable";

/** Detectability of one injected failure in one assessment call. */
export interface DetectabilityResult {
	probeId: string;
	callId: string;
	callMode?: "blocking" | "streaming";
	/** The class judged here, or "control" for a quiet healthy run. */
	failureClass: string;
	/** Whether this class is the one the probe injected. */
	injected: boolean;
	/** What actually happened, labelled from the program log and provider exchanges. */
	label: string;
	verdict: DetectabilityVerdict;
	/** Detector kinds that fired on this call's spans. */
	detections: string[];
	/** Why Sentry's telemetry was insufficient, one stable reason ID each. */
	reasons: Array<{ id: string; detail: string }>;
	sendDefaultPii?: boolean;
	genAIDataCollection?: boolean;
}

/** Provider exchanges observed between the start and end markers of one assessment call. */
export interface ProviderCallSummary {
	callId: string;
	probeId: string;
	exchanges: ProviderExchangeSummary[];
}

export interface VariantAssessment {
	id: string;
	identity: VariantIdentity;
	resolvedFrameworkVersion?: string;
	resolvedSentryVersion?: string;
	completion: AssessmentCompletion;
	health: AssessmentHealth;
	score: number;
	rating: AssessmentRating;
	probes: ProbeResult[];
	observations: Observation[];
	findings: Finding[];
	runtimeFailures: RuntimeFailure[];
	spans: CapturedSpan[];
	providerCalls?: ProviderCallSummary[];
	agentLogs?: AgentRunLog[];
	detectability?: DetectabilityResult[];
	generatedProgramPath?: string;
	logPath?: string;
}

export interface TargetAssessment {
	id: string;
	identity: TargetIdentity;
	completion: AssessmentCompletion;
	health: AssessmentHealth;
	score: number;
	rating: AssessmentRating;
	variants: VariantAssessment[];
	findings: Finding[];
	capabilitySummary: Record<string, CapabilityState>;
}

export interface AssessmentSummary {
	targets: number;
	variants: number;
	complete: number;
	incomplete: number;
	score: number;
	ratings: Record<AssessmentRating, number>;
	health: Record<AssessmentHealth, number>;
	findings: Record<FindingSeverity, number>;
}

export interface AssessmentReport {
	schemaVersion: "2";
	scoringVersion: "2" | "3";
	generatedAt: string;
	durationMs: number;
	targets: TargetAssessment[];
	summary: AssessmentSummary;
}
