import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedVariant } from "../assessment/matrix.js";
import type { ProviderExchange } from "./exchange.js";
import { recordedPath, recordedRequestHeaders, recordedResponseHeaders } from "./exchange.js";

export type ProviderTruthMode = false | true | "record" | "replay";
export interface CassetteHeader {
	cassette: 1;
	probeFingerprint: string;
	templateHash: string;
	recordedAt: string;
	upstreams: Record<string, string>;
}
export interface Cassette {
	header: CassetteHeader;
	exchanges: ProviderExchange[];
}
export interface CassetteSpec {
	file: string;
	header: CassetteHeader;
}
export function fingerprint(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
export function cassettePath(root: string, variant: ResolvedVariant, probeId: string): string {
	const optionsKey = [`framework=${encodeURIComponent(variant.identity.frameworkVersion)}`,
		...Object.entries(variant.identity.options).sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)].join(";");
	return path.join(root, ...variant.targetId.split("/"), optionsKey, `${encodeURIComponent(probeId)}.jsonl`);
}
export function sanitizedUpstreams(upstreams: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(Object.entries(upstreams).map(([name, base]) => {
		const url = new URL(base);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return [name, url.toString()];
	}));
}
export async function writeCassette(spec: CassetteSpec, exchanges: ProviderExchange[]): Promise<void> {
	const safe = exchanges.map((exchange) => {
		const url = new URL(exchange.path, "http://cassette");
		return { ...exchange, path: recordedPath(url.pathname, url.search),
			requestHeaders: recordedRequestHeaders(new Headers(exchange.requestHeaders)),
			responseHeaders: recordedResponseHeaders(new Headers(exchange.responseHeaders)) };
	});
	await mkdir(path.dirname(spec.file), { recursive: true });
	const temporary = `${spec.file}.${randomUUID()}.tmp`;
	await writeFile(temporary, [{ ...spec.header, upstreams: sanitizedUpstreams(spec.header.upstreams) }, ...safe].map((line) => JSON.stringify(line)).join("\n") + "\n");
	await rename(temporary, spec.file);
}
export async function readCassette(spec: CassetteSpec): Promise<Cassette | undefined> {
	let raw: string;
	try { raw = await readFile(spec.file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	const [header, ...exchanges] = raw.trim().split("\n").map((line) => JSON.parse(line));
	if (header?.cassette !== 1 || header.probeFingerprint !== spec.header.probeFingerprint || header.templateHash !== spec.header.templateHash) {
		throw new Error("cassette is stale, re-record");
	}
	for (const exchange of exchanges) {
		if (!exchange || !Number.isInteger(exchange.sequence) || typeof exchange.callId !== "string" ||
			typeof exchange.method !== "string" || typeof exchange.path !== "string" || typeof exchange.upstream !== "string" ||
			!Number.isInteger(exchange.status) || exchange.status < 200 || exchange.status > 599 ||
			typeof exchange.responseBody !== "string" || !exchange.responseHeaders || exchange.error ||
			(exchange.responseChunks !== undefined && (!Array.isArray(exchange.responseChunks) || exchange.responseChunks.some((chunk: unknown) => typeof chunk !== "string")))) {
			throw new Error("Invalid cassette exchange, re-record");
		}
	}
	return { header, exchanges };
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}
function bodyOf(exchange: Pick<ProviderExchange, "requestBody">): Record<string, unknown> {
	try {
		return object(JSON.parse(exchange.requestBody ?? "{}"));
	} catch {
		return {};
	}
}
/** Required wire invariants; SDK defaults and message text remain drift evidence. */
export function canonicalRequest(exchange: Pick<ProviderExchange, "method" | "path" | "requestBody" | "upstream">): unknown {
	const body = bodyOf(exchange);
	const pathname = exchange.path.split("?", 1)[0];
	const messages = body.messages ?? body.input ?? body.contents ?? [];
	const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((value: unknown) => {
		const tool = object(value);
		const declarations = tool.functionDeclarations ?? tool.function_declarations;
		return Array.isArray(declarations) ? declarations : [tool.function ?? tool];
	});
	return {
		upstream: exchange.upstream,
		method: exchange.method.toUpperCase(),
		path: pathname,
		stream: body.stream === true || pathname.includes(":streamGenerateContent"),
		model: body.model ?? pathname.match(/\/models\/([^:]+)/)?.[1],
		count: Array.isArray(messages) ? messages.length : 1,
		contentCounts: Array.isArray(messages) ? messages.map((value: unknown) => {
			const message = object(value);
			const content = message.content ?? message.parts;
			return Array.isArray(content) ? content.length : content === undefined ? 0 : 1;
		}) : [],
		tools: tools.map((tool: unknown) => object(tool).name ?? object(tool).type).sort(),
	};
}
function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
	}
	return value;
}
export function requestMatch(recorded: ProviderExchange, incoming: ProviderExchange): "match" | "drift" | "mismatch" {
	if (JSON.stringify(canonicalRequest(recorded)) !== JSON.stringify(canonicalRequest(incoming))) return "mismatch";
	return recorded.path === incoming.path && JSON.stringify(stable(bodyOf(recorded))) === JSON.stringify(stable(bodyOf(incoming))) ? "match" : "drift";
}
