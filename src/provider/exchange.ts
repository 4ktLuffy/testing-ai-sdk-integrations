/**
 * A provider HTTP exchange recorded by the span collector in provider-truth mode.
 *
 * Only an allow-list of headers is kept. Credentials (authorization, x-api-key,
 * x-goog-api-key, and key-like query parameters) are never stored.
 */
export interface ProviderExchange {
	sequence: number;
	callId?: string;
	upstream: string;
	method: string;
	path: string;
	status: number;
	requestHeaders: Record<string, string>;
	responseHeaders: Record<string, string>;
	requestBody?: string;
	responseBody: string;
	startedAt: string;
	finishedAt: string;
	clientDisconnected?: boolean;
	error?: string;
}

const requestHeaderAllowList = new Set([
	"accept",
	"content-type",
	"user-agent",
	"openai-beta",
	"sentry-trace",
	"baggage",
]);

const responseHeaderAllowList = new Set([
	"content-type",
	"x-request-id",
	"request-id",
	"openai-processing-ms",
	// Retry-controlling headers: SDKs decide whether and when to retry from these.
	"x-should-retry",
	"retry-after",
	"retry-after-ms",
]);

const sensitiveQueryParameter = /key|token|secret|auth|signature|sig$/i;

function allowedHeaders(
	headers: Headers,
	allowList: ReadonlySet<string>,
	allowPrefix?: string,
): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (
			allowList.has(lower) ||
			(allowPrefix !== undefined && lower.startsWith(allowPrefix))
		) {
			result[lower] = value;
		}
	});
	return result;
}

export function recordedRequestHeaders(
	headers: Headers,
): Record<string, string> {
	return allowedHeaders(headers, requestHeaderAllowList, "x-stainless-");
}

export function recordedResponseHeaders(
	headers: Headers,
): Record<string, string> {
	return allowedHeaders(headers, responseHeaderAllowList);
}

/** Remove credential-like query parameters such as Google's ?key=. */
export function recordedPath(pathname: string, search: string): string {
	const parameters = new URLSearchParams(search);
	for (const name of [...parameters.keys()]) {
		if (sensitiveQueryParameter.test(name)) parameters.delete(name);
	}
	const query = parameters.toString();
	return query ? `${pathname}?${query}` : pathname;
}
