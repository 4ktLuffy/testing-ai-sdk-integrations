import type { AssessmentCategory } from "./types.js";

export interface ProbeDefinition {
	id: string;
	description: string;
	/** A baseline failure prevents meaningful evidence for the remaining probes. */
	stopsVariantOnFailure: boolean;
}

const llmProbes: readonly ProbeDefinition[] = [
	{
		id: "llm.baseline",
		description: "A successful completion with system and user input.",
		stopsVariantOnFailure: true,
	},
	{
		id: "llm.multi_turn",
		description: "Several calls with increasing conversation history.",
		stopsVariantOnFailure: false,
	},
	{
		id: "llm.provider_error",
		description: "An intentionally invalid provider/API operation.",
		stopsVariantOnFailure: false,
	},
	{
		id: "llm.conversation",
		description: "Interleaved calls with two conversation identifiers.",
		stopsVariantOnFailure: false,
	},
	{
		id: "llm.long_input",
		description: "A request exceeding the telemetry trimming threshold.",
		stopsVariantOnFailure: false,
	},
];

const agentProbes: readonly ProbeDefinition[] = [
	{
		id: "agent.baseline",
		description: "An agent invocation without tools.",
		stopsVariantOnFailure: true,
	},
	{
		id: "agent.tools_success",
		description: "A deterministic add and multiply tool execution.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.tool_error",
		description: "A deterministic tool error.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.conversation",
		description: "Interleaved invocations with two conversation identifiers.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.long_input",
		description: "An invocation exceeding the telemetry trimming threshold.",
		stopsVariantOnFailure: false,
	},
];

/**
 * Failure-injection probes for agent frameworks. Opt-in (`--detectability`):
 * they run after the standard catalog and never stop the variant, because an
 * injected failure is the expected outcome.
 */
const agentFaultProbes: readonly ProbeDefinition[] = [
	{
		id: "agent.fault.control",
		description: "A healthy tool run; no detector may fire.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.fault.tool_loop",
		description: "A tool that always asks to be called again with the same arguments.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.fault.retry_storm",
		description: "The provider returns HTTP 500 three times before answering.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.fault.silent_tool_error",
		description: "A tool that returns an error payload instead of raising.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.fault.dead_end",
		description: "The step limit is reached before a final answer.",
		stopsVariantOnFailure: false,
	},
	{
		id: "agent.fault.truncated_answer",
		description: "A tiny output token limit cuts the final answer off.",
		stopsVariantOnFailure: false,
	},
];

export const FAULT_PROBE_PREFIX = "agent.fault.";

/**
 * Failure injection is implemented in the Node.js and Python harnesses only;
 * Next.js and Cloudflare Workers targets keep the standard catalog.
 */
export function detectabilityApplies(
	platform: string,
	detectability: boolean | undefined,
	variantOptions?: Readonly<Record<string, string>>,
): boolean {
	// The agent fault call is not implemented for Anthropic-provider variants:
	// scheduling fault probes there would run nothing and report noise.
	if (variantOptions?.provider === "anthropic") return false;
	return Boolean(detectability) && (platform === "node" || platform === "python");
}

export function isFaultProbe(probeId: string): boolean {
	return probeId.startsWith(FAULT_PROBE_PREFIX);
}

export function getProbeCatalog(
	category: AssessmentCategory,
	options: { detectability?: boolean } = {},
): readonly ProbeDefinition[] {
	if (category === "llm") return llmProbes;
	return options.detectability
		? [...agentProbes, ...agentFaultProbes]
		: agentProbes;
}
