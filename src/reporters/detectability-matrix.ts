/**
 * Failure detectability matrix: rows are platform/framework/variant (and the
 * data-collection setting), columns are failure classes, cells say whether
 * Sentry's telemetry let a detector see the failure, with run counts and the
 * reason when it did not.
 */
import type {
	AssessmentReport,
	DetectabilityResult,
	VariantAssessment,
} from "../assessment/types.js";

export const MATRIX_COLUMNS = [
	"tool_loop",
	"retry_storm",
	"silent_tool_error",
	"dead_end",
	"truncated_answer",
	"empty_answer",
	"control",
] as const;

export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export type CellStatus =
	| "detectable"
	| "partial"
	| "not_detectable"
	| "not_triggered"
	| "quiet"
	| "false_alarm"
	| "not_applicable";

export interface MatrixCell {
	status: CellStatus;
	/** Runs where the failure happened. */
	positives: number;
	/** Of those, runs a detector caught. */
	detected: number;
	falseAlarms: number;
	/** Runs where the injected failure did not happen, by what happened instead. */
	notTriggered: Record<string, number>;
	/** Stable reason IDs with run counts, for runs where the failure was missed. */
	reasons: Record<string, number>;
	/** Data that would have been missing in runs where the failure did not happen. */
	gaps: Record<string, number>;
	/** One example detail per reason ID. */
	details: Record<string, string>;
	text: string;
}

export interface MatrixRow {
	key: string;
	platform: string;
	framework: string;
	variant: string;
	sendDefaultPii: boolean | undefined;
	runs: number;
	cells: Record<MatrixColumn, MatrixCell>;
}

function emptyCell(): MatrixCell {
	return {
		status: "not_applicable",
		positives: 0,
		detected: 0,
		falseAlarms: 0,
		notTriggered: {},
		reasons: {},
		gaps: {},
		details: {},
		text: "n/a",
	};
}

function bump(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

function counted(record: Record<string, number>): string {
	return Object.entries(record)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, count]) => (count > 1 ? `${key} x${count}` : key))
		.join(", ");
}

function finishCell(cell: MatrixCell, column: MatrixColumn, runs: number): void {
	const alarms = cell.falseAlarms > 0 ? `; false alarm x${cell.falseAlarms}` : "";
	if (column === "control") {
		if (runs === 0) return;
		cell.status = cell.falseAlarms > 0 ? "false_alarm" : "quiet";
		cell.text =
			cell.falseAlarms > 0
				? `false alarm on ${cell.falseAlarms}/${runs} healthy run(s): ${counted(cell.reasons)}`
				: `quiet ${runs}/${runs}`;
		return;
	}
	if (cell.positives > 0) {
		const ratio = `${cell.detected}/${cell.positives}`;
		if (cell.detected === cell.positives) {
			cell.status = "detectable";
			cell.text = `detectable ${ratio}${alarms}`;
		} else {
			cell.status = cell.detected === 0 ? "not_detectable" : "partial";
			cell.text = `${cell.detected === 0 ? "not detectable" : "partly detectable"} ${ratio} (${counted(cell.reasons)})${alarms}`;
		}
		return;
	}
	const triggeredNot = Object.keys(cell.notTriggered).length > 0;
	if (triggeredNot) {
		cell.status = cell.falseAlarms > 0 ? "false_alarm" : "not_triggered";
		const gaps = Object.keys(cell.gaps).length > 0
			? `; data gap if it had: ${counted(cell.gaps)}`
			: "; data present";
		cell.text = `not triggered (${counted(cell.notTriggered)})${gaps}${alarms}`;
		return;
	}
	if (cell.falseAlarms > 0) {
		cell.status = "false_alarm";
		cell.text = `false alarm x${cell.falseAlarms}`;
	}
}

function variantLabel(variant: VariantAssessment): string {
	const parts = [
		...Object.entries(variant.identity.options).map(
			([key, value]) => `${key}=${value}`,
		),
		...(variant.identity.executionMode ? [variant.identity.executionMode] : []),
	];
	return parts.length > 0 ? parts.join(", ") : "default";
}

function targetParts(variantId: string): { platform: string; framework: string } {
	const [platform = "", , framework = ""] = variantId.split("/");
	return { platform, framework };
}

/** Build the matrix from any number of variant assessments (repeated runs merge). */
export function buildDetectabilityMatrix(
	variants: readonly VariantAssessment[],
): MatrixRow[] {
	const rows = new Map<string, MatrixRow & { controlRuns: number }>();
	for (const variant of variants) {
		if (!variant.detectability || variant.detectability.length === 0) continue;
		const byPii = new Map<string, DetectabilityResult[]>();
		for (const result of variant.detectability) {
			const pii = String(result.sendDefaultPii ?? "unknown");
			byPii.set(pii, [...(byPii.get(pii) ?? []), result]);
		}
		for (const [pii, results] of byPii) {
			const key = `${variant.id}|pii=${pii}`;
			const { platform, framework } = targetParts(variant.id);
			const row =
				rows.get(key) ??
				({
					key,
					platform,
					framework,
					variant: variantLabel(variant),
					sendDefaultPii: pii === "unknown" ? undefined : pii === "true",
					runs: 0,
					cells: Object.fromEntries(
						MATRIX_COLUMNS.map((column) => [column, emptyCell()]),
					) as Record<MatrixColumn, MatrixCell>,
					controlRuns: 0,
				} as MatrixRow & { controlRuns: number });
			// Each variant assessment is one execution; call IDs repeat across executions.
			const runIds = new Set<string>();
			const controlIds = new Set<string>();
			for (const result of results) {
				runIds.add(result.callId);
				const isControl = result.probeId === "agent.fault.control";
				if (isControl) controlIds.add(result.callId);
				if (isControl && result.verdict === "false_alarm") {
					const cell = row.cells.control;
					cell.falseAlarms += 1;
					for (const reason of result.reasons) {
						bump(cell.reasons, reason.id);
						cell.details[reason.id] ??= reason.detail;
					}
				}
				const column = result.failureClass as MatrixColumn;
				if (!MATRIX_COLUMNS.includes(column) || column === "control") continue;
				const cell = row.cells[column];
				switch (result.verdict) {
					case "detectable":
						cell.positives += 1;
						cell.detected += 1;
						break;
					case "undetectable":
						cell.positives += 1;
						for (const reason of result.reasons) {
							bump(cell.reasons, reason.id);
							cell.details[reason.id] ??= reason.detail;
						}
						break;
					case "false_alarm":
						if (!isControl) cell.falseAlarms += 1;
						break;
					case "not_triggered":
						bump(cell.notTriggered, result.label);
						for (const reason of result.reasons) {
							bump(cell.gaps, reason.id);
							cell.details[reason.id] ??= reason.detail;
						}
						break;
				}
			}
			row.runs += runIds.size;
			row.controlRuns += controlIds.size;
			rows.set(key, row);
		}
	}
	return [...rows.values()]
		.map(({ controlRuns, ...row }) => {
			for (const column of MATRIX_COLUMNS) {
				finishCell(row.cells[column], column, column === "control" ? controlRuns : row.runs);
			}
			return row;
		})
		.sort((left, right) => left.key.localeCompare(right.key));
}

export function reportDetectabilityMatrix(report: AssessmentReport): MatrixRow[] {
	return buildDetectabilityMatrix(
		report.targets.flatMap((target) => target.variants),
	);
}

function rowLabel(row: MatrixRow): string {
	const pii =
		row.sendDefaultPii === undefined
			? ""
			: row.sendDefaultPii
				? ", send_default_pii on"
				: ", send_default_pii off";
	return `${row.platform}/${row.framework} (${row.variant}${pii})`;
}

/** Markdown table, one row per variant and data-collection setting. */
export function renderDetectabilityMarkdown(rows: readonly MatrixRow[]): string {
	const header = `| target | runs | ${MATRIX_COLUMNS.join(" | ")} |`;
	const divider = `|${" --- |".repeat(MATRIX_COLUMNS.length + 2)}`;
	const body = rows.map(
		(row) =>
			`| ${rowLabel(row)} | ${row.runs} | ${MATRIX_COLUMNS.map((column) => row.cells[column].text.replaceAll("|", "/")).join(" | ")} |`,
	);
	return [header, divider, ...body].join("\n");
}

function escapeHtml(value: unknown): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const statusColors: Record<CellStatus, string> = {
	detectable: "var(--green-soft)",
	quiet: "var(--green-soft)",
	partial: "var(--yellow-soft)",
	not_detectable: "var(--orange-soft)",
	false_alarm: "var(--orange-soft)",
	not_triggered: "var(--surface-soft)",
	not_applicable: "var(--surface)",
};

/** Standalone HTML section; empty when no variant ran failure injection. */
export function renderDetectabilityHtml(rows: readonly MatrixRow[]): string {
	if (rows.length === 0) return "";
	const head = MATRIX_COLUMNS.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
	const body = rows
		.map((row) => {
			const cells = MATRIX_COLUMNS.map((column) => {
				const cell = row.cells[column];
				const title = Object.entries(cell.details)
					.map(([id, detail]) => `${id}: ${detail}`)
					.join("\n");
				return `<td style="background:${statusColors[cell.status]}" title="${escapeHtml(title)}">${escapeHtml(cell.text)}</td>`;
			}).join("");
			return `<tr><th>${escapeHtml(rowLabel(row))}</th><td>${row.runs}</td>${cells}</tr>`;
		})
		.join("");
	return `<section class="detectability-panel"><div class="section-heading"><h2>failure detectability</h2><span>injected agent failures, labelled from each program's own log and recorded provider exchanges; hover a cell for the missing data</span></div><div class="table-shell"><table class="matrix detectability-matrix"><thead><tr><th>target</th><th>runs</th>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}
