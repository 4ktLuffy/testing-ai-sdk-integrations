import type { AssessmentCategory } from "../assessment/types.js";

interface ProbeMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface CompletionInput {
	model: string;
	messages: ProbeMessage[];
	conversationId?: string;
	streaming?: boolean;
}

export interface LlmProbeInput {
	calls: CompletionInput[];
	expectError?: boolean;
	originalInputBytes?: number;
}

export interface AgentToolInput {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	arguments: Record<string, unknown>;
	result?: unknown;
	error?: string;
	/** The fixed result is an error payload returned as a successful value. */
	errorPayload?: boolean;
}

export interface AgentProbeInput extends LlmProbeInput {
	tools?: AgentToolInput[];
	/** Present only on opt-in failure-injection probes (`--detectability`). */
	fault?: AgentFaultInput;
}

/** Failure classes that the detectability layer injects and evaluates. */
export type FailureClass =
	| "tool_loop"
	| "retry_storm"
	| "silent_tool_error"
	| "dead_end"
	| "truncated_answer";

/**
 * What a failure-injection probe changes. Adapters apply these settings and
 * nothing else: tools return their fixed `result`, and the limits below map to
 * the framework's own step, token, and retry settings.
 */
export interface AgentFaultInput {
	/** The class this probe injects; absent for the healthy control. */
	failureClass?: FailureClass;
	/** Model requests allowed in one agent run (turn/step/request limit). */
	maxModelCalls: number;
	/** Output token limit for every model request in the run. */
	maxOutputTokens?: number;
	/** Client retry budget, so a scripted provider fault can be outlasted. */
	maxRetries?: number;
	/** Scripted fault served by the provider-truth recorder for this call. */
	providerFault?: "provider_500x3";
}

const assistant = "You are a helpful assistant. Respond briefly.";
const capitalQuestion = "What is the capital of France?";
const longPattern =
	"This is a test message that will be repeated many times to create a very long input. ";
const longMessage = longPattern.repeat(300);

const llmProbeInputs: Record<string, LlmProbeInput> = {
	"llm.baseline": {
		calls: [
			{
				model: "gpt-5-nano",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
				],
			},
		],
	},
	"llm.multi_turn": {
		calls: [
			{
				model: "gpt-5-nano",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
				],
			},
			{
				model: "gpt-5-nano",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
					{ role: "assistant", content: "The capital of France is Paris." },
					{ role: "user", content: "What is the population of that city?" },
				],
			},
			{
				model: "gpt-5-nano",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
					{ role: "assistant", content: "The capital of France is Paris." },
					{ role: "user", content: "What is the population of that city?" },
					{
						role: "assistant",
						content:
							"Paris has a population of approximately 2.2 million people in the city proper.",
					},
					{ role: "user", content: "What about the metropolitan area?" },
				],
			},
		],
	},
	"llm.provider_error": {
		expectError: true,
		calls: [
			{
				model: "sentry-assessment-invalid-model",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
				],
			},
		],
	},
	"llm.conversation": {
		calls: [
			{
				model: "gpt-5-nano",
				conversationId: "assessment-conversation-a",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
				],
			},
			{
				model: "gpt-5-nano",
				conversationId: "assessment-conversation-b",
				messages: [
					{ role: "system", content: "You are a math tutor." },
					{ role: "user", content: "What is 2 + 2?" },
				],
			},
			{
				model: "gpt-5-nano",
				conversationId: "assessment-conversation-a",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
					{ role: "assistant", content: "The capital of France is Paris." },
					{ role: "user", content: "What about Germany?" },
				],
			},
			{
				model: "gpt-5-nano",
				conversationId: "assessment-conversation-b",
				messages: [
					{ role: "system", content: "You are a math tutor." },
					{ role: "user", content: "What is 2 + 2?" },
					{ role: "assistant", content: "2 + 2 equals 4." },
					{ role: "user", content: "What about 3 + 3?" },
				],
			},
		],
	},
	"llm.long_input": {
		calls: [
			{
				model: "gpt-4o-mini",
				messages: [
					{ role: "system", content: assistant },
					{
						role: "user",
						content: `Summarize this in one sentence: ${longMessage}`,
					},
				],
			},
		],
		originalInputBytes: Buffer.byteLength(longMessage),
	},
};

const agentLongMessage = longPattern.repeat(300);

const agentProbeInputs: Record<string, AgentProbeInput> = {
	"agent.baseline": {
		calls: [
			{
				model: "gpt-4o-mini",
				messages: [
					{ role: "system", content: assistant },
					{ role: "user", content: capitalQuestion },
				],
			},
		],
	},
	"agent.tools_success": {
		calls: [
			{
				model: "gpt-4o-mini",
				messages: [
					{
						role: "user",
						content: "Calculate (3 + 5) * 4. Use add, then multiply.",
					},
				],
			},
		],
		tools: [
			{
				name: "add",
				description: "Add two numbers together",
				parameters: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
				arguments: { a: 3, b: 5 },
				result: 8,
			},
			{
				name: "multiply",
				description: "Multiply two numbers together",
				parameters: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
				arguments: { a: 8, b: 4 },
				result: 32,
			},
		],
	},
	"agent.tool_error": {
		calls: [
			{
				model: "gpt-4o-mini",
				messages: [
					{
						role: "user",
						content: "Read /nonexistent/file.txt with the read_file tool.",
					},
				],
			},
		],
		tools: [
			{
				name: "read_file",
				description: "Read a file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
				arguments: { path: "/nonexistent/file.txt" },
				error: "FileNotFoundError: /nonexistent/file.txt does not exist",
			},
		],
	},
	"agent.conversation": {
		calls: [
			{
				model: "gpt-4o-mini",
				conversationId: "assessment-agent-a",
				messages: [{ role: "user", content: capitalQuestion }],
			},
			{
				model: "gpt-4o-mini",
				conversationId: "assessment-agent-b",
				messages: [{ role: "user", content: "What is 2 + 2?" }],
			},
			{
				model: "gpt-4o-mini",
				conversationId: "assessment-agent-a",
				messages: [{ role: "user", content: "What about Germany?" }],
			},
			{
				model: "gpt-4o-mini",
				conversationId: "assessment-agent-b",
				messages: [{ role: "user", content: "What about 3 + 3?" }],
			},
		],
	},
	"agent.long_input": {
		calls: [
			{
				model: "gpt-4o-mini",
				messages: [
					{
						role: "user",
						content: `Summarize this in one sentence: ${agentLongMessage}`,
					},
				],
			},
		],
		originalInputBytes: Buffer.byteLength(agentLongMessage),
		tools: [
			{
				name: "get_word_count",
				description: "Count words in text",
				parameters: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				},
				arguments: { text: agentLongMessage },
				result: 2400,
			},
		],
	},
};

const lookupOrder: Omit<AgentToolInput, "result"> = {
	name: "lookup_order",
	description: "Look up an order's status by its id.",
	parameters: {
		type: "object",
		properties: { order_id: { type: "string" } },
		required: ["order_id"],
	},
	arguments: { order_id: "A-1042" },
};

const searchDocs: Omit<AgentToolInput, "result"> = {
	name: "search_docs",
	description: "Search the internal help-center documents.",
	parameters: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
	arguments: { query: "refund policy" },
};

const orderTask =
	"Look up order A-1042 with the lookup_order tool and tell me its status in one sentence.";
const refundTask =
	"Find the refund policy using the search_docs tool and summarize it in one sentence.";

/**
 * Failure-injection probes (opt-in). Faults live in the tools, the limits, and
 * the provider-truth recorder, never in the model: the model's reaction is
 * real, so each run is labelled by what the program observed, not by intent.
 * Tool results are returned as successful values (an error payload is not raised).
 */
const faultProbeInputs: Record<string, AgentProbeInput> = {
	"agent.fault.control": {
		calls: [{ model: "gpt-4o-mini", messages: [{ role: "user", content: orderTask }] }],
		tools: [
			{ ...lookupOrder, result: "Order A-1042: shipped on Oct 3, arriving Oct 7." },
		],
		fault: { maxModelCalls: 4 },
	},
	"agent.fault.tool_loop": {
		calls: [{ model: "gpt-4o-mini", messages: [{ role: "user", content: refundTask }] }],
		tools: [
			{
				...searchDocs,
				result:
					"No results yet. Please call this tool again with exactly the same arguments.",
			},
		],
		fault: { failureClass: "tool_loop", maxModelCalls: 5 },
	},
	"agent.fault.retry_storm": {
		calls: [
			{
				model: "gpt-4o-mini",
				messages: [{ role: "user", content: capitalQuestion }],
			},
		],
		fault: {
			failureClass: "retry_storm",
			maxModelCalls: 2,
			maxRetries: 4,
			providerFault: "provider_500x3",
		},
	},
	"agent.fault.silent_tool_error": {
		calls: [{ model: "gpt-4o-mini", messages: [{ role: "user", content: orderTask }] }],
		tools: [
			{
				...lookupOrder,
				result: JSON.stringify({
					ok: false,
					error: "upstream 503: service unavailable",
				}),
				errorPayload: true,
			},
		],
		fault: { failureClass: "silent_tool_error", maxModelCalls: 4 },
	},
	"agent.fault.dead_end": {
		calls: [{ model: "gpt-4o-mini", messages: [{ role: "user", content: refundTask }] }],
		tools: [
			{
				...searchDocs,
				result:
					"Partial results only. Call this tool again with the same query to get the rest.",
			},
		],
		fault: { failureClass: "dead_end", maxModelCalls: 2 },
	},
	"agent.fault.truncated_answer": {
		calls: [
			{
				model: "gpt-4o-mini",
				messages: [
					{
						role: "user",
						content:
							"Explain in three detailed paragraphs how photosynthesis works.",
					},
				],
			},
		],
		fault: {
			failureClass: "truncated_answer",
			maxModelCalls: 2,
			maxOutputTokens: 48,
		},
	},
};

/**
 * Probe inputs are category-owned data, not a matrix axis. Failure-injection
 * inputs are always available for lookup; the catalog decides whether they run.
 */
export function getProbeInputs(
	category: AssessmentCategory,
): Record<string, LlmProbeInput | AgentProbeInput> {
	return category === "llm"
		? llmProbeInputs
		: { ...agentProbeInputs, ...faultProbeInputs };
}
