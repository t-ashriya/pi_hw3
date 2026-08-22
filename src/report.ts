import { basename, join, relative } from "node:path";
import type { PaperReport, ReferenceCheck, SummaryReport, Verdict } from "./types.ts";
import { firstLine, writeText } from "./utils.ts";

export function paperReportMarkdownPath(outDir: string, slug: string): string {
	return join(outDir, "reports", `${slug}.report.md`);
}

export async function writePaperReport(report: PaperReport): Promise<{ markdownPath: string }> {
	const mdPath = paperReportMarkdownPath(report.outputDir, report.slug);
	await writeText(mdPath, renderPaperReport(report));
	return { markdownPath: mdPath };
}

export async function writeSummaryReport(summary: SummaryReport): Promise<{ markdownPath: string }> {
	const mdPath = join(summary.outDir, "summary.md");
	await writeText(mdPath, renderSummaryReport(summary));
	return { markdownPath: mdPath };
}

export function makeSummary(
	startedAt: string,
	finishedAt: string,
	outDir: string,
	options: SummaryReport["options"],
	papers: PaperReport[],
	skipped: SummaryReport["skipped"] = [],
): SummaryReport {
	const counts = emptyVerdictCounts();
	for (const paper of papers) {
		for (const check of paper.checks) {
			counts.total++;
			counts[check.verdict]++;
		}
	}
	return { startedAt, finishedAt, outDir, options, papers, skipped, counts };
}

function renderSummaryReport(summary: SummaryReport): string {
	const lines: string[] = [];
	lines.push("# Citecheck Summary", "");
	lines.push(`Started: ${summary.startedAt}`);
	lines.push(`Finished: ${summary.finishedAt}`);
	lines.push(`Output directory: \`${summary.outDir}\``, "");
	lines.push("## Papers that need attention", "");
	const attentionRows: string[] = [];
	for (const paper of summary.papers) {
		const counts = countPaperVerdicts(paper);
		if (counts["likely-hallucinated"] === 0 && counts.unverified === 0 && counts["needs-manual-review"] === 0) continue;
		attentionRows.push(
			`| ${escapeTable(basename(paper.inputPath))} | ${counts["likely-hallucinated"]} | ${counts.unverified} | ${counts["needs-manual-review"]} |`,
		);
	}
	if (attentionRows.length > 0) {
		lines.push("| Paper | likely-hallucinated | unverified | needs-manual-review |", "|---|---:|---:|---:|", ...attentionRows);
	} else {
		lines.push("_No papers need attention._");
	}
	lines.push("", "## Citation checks on all papers", "");
	lines.push(
		"| Paper | Total references | valid | likely-valid | likely-hallucinated | unverified | needs-manual-review |",
		"|---|---:|---:|---:|---:|---:|---:|",
	);
	for (const paper of summary.papers) {
		const counts = countPaperVerdicts(paper);
		lines.push(
			`| ${escapeTable(basename(paper.inputPath))} | ${counts.total} | ${counts.valid} | ${counts["likely-valid"]} | ${counts["likely-hallucinated"]} | ${counts.unverified} | ${counts["needs-manual-review"]} |`,
		);
	}
	if (summary.skipped.length > 0) {
		lines.push("", "## Skipped existing reports", "");
		lines.push("These papers were not reprocessed because `--out` was used and a per-paper report already exists.", "");
		lines.push("| Paper | Existing report | Reason |", "|---|---|---|");
		for (const skipped of summary.skipped) {
			lines.push(
				`| ${escapeTable(basename(skipped.inputPath))} | \`${escapeTable(relative(summary.outDir, skipped.reportPath) || ".")}\` | ${escapeTable(skipped.reason)} |`,
			);
		}
	}
	lines.push("");
	return lines.join("\n");
}

function countPaperVerdicts(paper: PaperReport): Record<Verdict | "total", number> {
	const counts = emptyVerdictCounts();
	for (const check of paper.checks) {
		counts.total++;
		counts[check.verdict]++;
	}
	return counts;
}

function emptyVerdictCounts(): Record<Verdict | "total", number> {
	return {
		total: 0,
		valid: 0,
		"likely-valid": 0,
		unverified: 0,
		"likely-hallucinated": 0,
		"needs-manual-review": 0,
	};
}

function renderPaperReport(report: PaperReport): string {
	const rel = (path: string | undefined) => (path ? relative(report.outputDir, path) || "." : "");
	const lines: string[] = [];
	lines.push(`# Citecheck Report: ${basename(report.inputPath)}`, "");
	lines.push(`Input: \`${report.inputPath}\``);
	lines.push(`Started: ${report.startedAt}`);
	lines.push(`Finished: ${report.finishedAt}`);
	lines.push(`Conversion mode: \`${report.conversionMode}\``);
	if (report.refsOnlyPdf?.path) {
		lines.push(
			`References-only PDF: \`${rel(report.refsOnlyPdf.path)}\` (${formatRefsOnlyPdfRange(report.refsOnlyPdf)}, method ${report.refsOnlyPdf.method})`,
		);
	} else if (report.refsOnlyPdf?.startPage) {
		lines.push(`${formatRefsOnlyPdfRange(report.refsOnlyPdf)} (full PDF converted).`);
	}
	lines.push("");

	if (report.warnings.length > 0) {
		lines.push("## Warnings", "");
		for (const warning of report.warnings) lines.push(`- ${warning}`);
		lines.push("");
	}
	if (report.errors.length > 0) {
		lines.push("## Errors", "");
		for (const error of report.errors) lines.push(`- ${error}`);
		lines.push("");
	}

	lines.push("## Conversion artifacts", "");
	lines.push("| Mode | Markdown | References section | Entries | Section found |", "|---|---|---|---:|---|");
	for (const artifact of report.artifacts) {
		lines.push(
			`| ${artifact.mode} | \`${rel(artifact.markdownPath)}\` | \`${rel(artifact.refsPath)}\` | ${artifact.references.length} | ${artifact.section.found ? "yes" : "no"} |`,
		);
	}
	lines.push("");

	if (report.comparison) {
		lines.push("## Conversion comparison", "");
		lines.push(`Primary conversion: \`${report.comparison.primaryMode}\``);
		lines.push(report.comparison.primaryReason, "");
		for (const note of report.comparison.summary) lines.push(`- ${note}`);
		if (report.comparison.summary.length > 0) lines.push("");
	}

	lines.push("## Reference verdicts", "");
	lines.push("| # | Verdict | Confidence | Query | Reason |", "|---:|---|---:|---|---|");
	for (const check of report.checks) {
		lines.push(
			`| ${check.entry.index} | ${check.verdict} | ${check.confidence.toFixed(2)} | ${escapeTable(check.normalized.query)} | ${escapeTable(firstLine(check.reason, 180))} |`,
		);
	}
	lines.push("");

	lines.push("## Details", "");
	for (const check of report.checks) {
		appendCheckDetails(lines, check, report.outputDir);
	}
	return lines.join("\n");
}

function appendCheckDetails(lines: string[], check: ReferenceCheck, outDir: string): void {
	const rel = (path: string | undefined) => (path ? relative(outDir, path) || "." : "");
	lines.push(`### Reference ${check.entry.index}: ${check.verdict}`, "");
	lines.push(`Confidence: ${check.confidence.toFixed(2)}`);
	lines.push(`Reason: ${check.reason}`);
	lines.push(`Discrepancy: ${check.discrepancy}`);
	if (check.conversionNotes.length > 0) {
		lines.push("", "Conversion notes:");
		for (const note of check.conversionNotes) lines.push(`- ${note}`);
	}
	lines.push("", "Original reference:", "");
	lines.push("> " + check.entry.raw.replace(/\n/g, "\n> "), "");
	lines.push("Extracted fields:");
	for (const [key, value] of Object.entries(check.normalized)) {
		if (value && key !== "query") lines.push(`- ${key}: ${value}`);
	}
	lines.push(`- search query: ${check.normalized.query}`);
	if (check.evidence) {
		lines.push("", "Search evidence:");
		if (check.evidence.rawTextPath) lines.push(`- raw text: \`${rel(check.evidence.rawTextPath)}\``);
		const results = check.evidence.results ?? [{
			stage: "primary" as const,
			query: check.evidence.query,
			resultText: check.evidence.resultText,
			exitCode: check.evidence.exitCode ?? 0,
		}];
		for (const result of results) {
			const selected = result.stage === (check.evidence.selectedResult ?? "primary");
			const label = result.stage === "primary" ? "Primary web search result" : "Citation recheck result";
			lines.push("", `#### ${label}${selected ? " (used for classification)" : ""}`, "");
			lines.push(`Query: ${result.query}`, `Exit code: ${result.exitCode}`, "");
			appendBlockquote(lines, result.resultText || "_(empty result)_");
		}
		if (check.evidenceUrls.length > 0) {
			lines.push("", "Evidence URLs:");
			for (const url of check.evidenceUrls) lines.push(`- ${url}`);
		}
	}
	lines.push("");
}

function appendBlockquote(lines: string[], text: string): void {
	for (const line of text.split("\n")) lines.push(`> ${line}`);
}

function formatRefsOnlyPdfRange(refsOnlyPdf: NonNullable<PaperReport["refsOnlyPdf"]>): string {
	const source = refsOnlyPdf.source === "specified" ? "specified" : "detected";
	if (refsOnlyPdf.startPage && refsOnlyPdf.endPage && refsOnlyPdf.startPage === refsOnlyPdf.endPage) {
		return `${source} references page ${refsOnlyPdf.startPage}`;
	}
	if (refsOnlyPdf.startPage && refsOnlyPdf.endPage) {
		return `${source} references pages ${refsOnlyPdf.startPage}-${refsOnlyPdf.endPage}`;
	}
	if (refsOnlyPdf.startPage) {
		return `${source} references start page ${refsOnlyPdf.startPage}`;
	}
	return `${source} references pages`;
}

function escapeTable(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
