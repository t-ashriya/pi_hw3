import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isCitecheckAbort, throwIfAborted } from "./cancel.ts";
import { parseCitecheckArgs, USAGE } from "./args.ts";
import { compareConversions, choosePrimary } from "./compare.ts";
import { artifactFromMarkdown, prepareRefsOnlyPdf, runDoclingConversions } from "./convert.ts";
import { discoverInputs } from "./discover.ts";
import { normalizeReference } from "./normalize.ts";
import { makeSummary, paperReportMarkdownPath, writePaperReport, writeSummaryReport } from "./report.ts";
import { classifyEvidence } from "./verdict.ts";
import { checkReferencesWithSearch, locateNativeWebSearch } from "./web-search.ts";
import type { DiscoveredInput, PaperReport, ReferenceCheck, RunBridge, SkippedPaperReport, Verdict } from "./types.ts";
import { ensureDir, slugifyPath, timestampForPath } from "./utils.ts";

const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;
const SEARCH_PROGRESS_REF_STEP = 5;

export async function runCitecheck(rawArgs: string, bridge: RunBridge): Promise<void> {
	const parsed = parseCitecheckArgs(rawArgs);
	if (parsed.help) {
		bridge.ui?.notify?.(USAGE, "info");
		return;
	}
	if (!parsed.ok || !parsed.options) {
		bridge.ui?.notify?.(parsed.error ?? "Invalid /citecheck arguments", "error");
		return;
	}

	throwIfAborted(bridge.signal);
	const options = parsed.options;
	const startedAt = new Date().toISOString();
	const outDir = resolve(bridge.cwd, options.outDir ?? join(".pi", "citecheck", timestampForPath()));
	await ensureDir(outDir);

	try {
		throwIfAborted(bridge.signal);
		bridge.ui?.setStatus?.("citecheck", "discovering inputs");
		const inputs = await discoverInputs(bridge.cwd, options.input, options.fromMd, options.recursive);
		throwIfAborted(bridge.signal);
		if (inputs.length === 0) {
			bridge.ui?.notify?.("/citecheck found no matching input files.", "warning");
			return;
		}

		emitProgress(
			bridge,
			`/citecheck processing ${inputs.length} ${options.fromMd ? "Markdown" : "PDF"} file(s). Output: ${outDir}`,
			"info",
		);

		const reports: PaperReport[] = [];
		const skipped: SkippedPaperReport[] = [];
		let searchScript: string | undefined;
		for (let i = 0; i < inputs.length; i++) {
			throwIfAborted(bridge.signal);
			const input = inputs[i]!;
			const slug = slugifyPath(input.path);
			const inputLabel = `${i + 1}/${inputs.length}: ${slug}`;
			if (options.outDir !== undefined) {
				const existingReportPath = paperReportMarkdownPath(outDir, slug);
				if (existsSync(existingReportPath)) {
					const reason = "existing report found";
					skipped.push({ inputPath: input.path, slug, reportPath: existingReportPath, reason });
					emitProgress(bridge, `/citecheck paper ${inputLabel} skipped — ${reason}: ${existingReportPath}`, "info");
					continue;
				}
			}
			bridge.ui?.setStatus?.("citecheck", `processing ${inputLabel}`);
			emitProgress(bridge, `/citecheck paper ${inputLabel} started`, "info");
			if (!searchScript) {
				searchScript = await locateNativeWebSearch(bridge.getCommands);
				throwIfAborted(bridge.signal);
				if (!searchScript) {
					bridge.ui?.notify?.("Could not locate native-web-search/search.mjs. Is the native-web-search skill installed?", "error");
					return;
				}
			}
			const report = await processOneInput(input, outDir, options, bridge, searchScript);
			throwIfAborted(bridge.signal);
			reports.push(report);
			await writePaperReport(report);
			emitProgress(bridge, `/citecheck paper ${inputLabel} complete — ${formatPaperSummary(report)}`, report.errors.length > 0 ? "warning" : "info");
		}

		const finishedAt = new Date().toISOString();
		const summary = makeSummary(startedAt, finishedAt, outDir, options, reports, skipped);
		const written = await writeSummaryReport(summary);
		emitProgress(bridge, `/citecheck complete: ${formatRunSummary(reports, skipped.length)} Summary: ${written.markdownPath}`, "info");
	} finally {
		bridge.ui?.setStatus?.("citecheck", undefined);
	}
}

type ResolvedOptions = NonNullable<ReturnType<typeof parseCitecheckArgs>["options"]>;

async function processOneInput(
	input: DiscoveredInput,
	outDir: string,
	options: ResolvedOptions,
	bridge: RunBridge,
	searchScript: string,
): Promise<PaperReport> {
	const startedAt = new Date().toISOString();
	const slug = slugifyPath(input.path);
	const warnings: string[] = [];
	const errors: string[] = [];
	let refsOnlyPdf;
	let artifacts = [] as PaperReport["artifacts"];
	let checks: ReferenceCheck[] = [];

	try {
		throwIfAborted(bridge.signal);
		if (input.kind === "pdf") {
			const refsPhase = options.refsPage === undefined
				? `locating references pages: ${slug}`
				: `extracting references page ${options.refsPage}: ${slug}`;
			bridge.ui?.setStatus?.(
				"citecheck",
				refsPhase,
			);
			emitProgress(bridge, `/citecheck ${refsPhase}`, "info");
			refsOnlyPdf = await withProgressHeartbeat(
				bridge,
				() => `/citecheck still ${refsPhase}`,
				() => prepareRefsOnlyPdf(input.path, slug, outDir, bridge.exec, bridge.signal, options.refsPage),
			);
			throwIfAborted(bridge.signal);
			warnings.push(...refsOnlyPdf.warnings);
			const pdfForDocling = refsOnlyPdf.path ?? input.path;
			bridge.ui?.setStatus?.("citecheck", `docling ${options.conversion}: ${slug}`);
			emitProgress(bridge, `/citecheck docling ${options.conversion} started: ${slug}`, "info");
			artifacts = await withProgressHeartbeat(
				bridge,
				() => `/citecheck docling ${options.conversion} still running: ${slug}`,
				() => runDoclingConversions(pdfForDocling, slug, outDir, options, bridge.exec, bridge.signal),
			);
			throwIfAborted(bridge.signal);
		} else {
			emitProgress(bridge, `/citecheck reading Markdown references: ${slug}`, "info");
			artifacts = [await artifactFromMarkdown(input.path, slug, outDir)];
			throwIfAborted(bridge.signal);
		}

		for (const artifact of artifacts) {
			warnings.push(...artifact.section.warnings.map((warning) => `${artifact.mode}: ${warning}`));
			if (artifact.references.length === 0) {
				warnings.push(`${artifact.mode}: extracted references section contains no split reference entries.`);
			}
		}

		const comparison = compareConversions(artifacts);
		const primary = choosePrimary(artifacts);
		let referenceEntries = primary.references;
		emitProgress(
			bridge,
			`/citecheck extracted ${referenceEntries.length} primary reference(s) from ${slug} (${primary.mode} conversion)`,
			"info",
		);
		if (options.maxRefs !== undefined && referenceEntries.length > options.maxRefs) {
			warnings.push(`Only checked the first ${options.maxRefs} references because --max-refs was set.`);
			referenceEntries = referenceEntries.slice(0, options.maxRefs);
		}

		if (referenceEntries.length > 0) {
			throwIfAborted(bridge.signal);
			await confirmSearchIfNeeded(referenceEntries.length, input.path, options, bridge);
			throwIfAborted(bridge.signal);
			const refsForSearch = referenceEntries.map((entry) => ({
				entry,
				normalized: normalizeReference(entry),
				conversionNotes: comparison?.notesByPrimaryIndex[entry.index] ?? [],
			}));

			bridge.ui?.setStatus?.("citecheck", `web-search 0/${refsForSearch.length}: ${slug}`);
			emitProgress(
				bridge,
				`/citecheck web-search started: ${slug} — ${refsForSearch.length} reference(s), concurrency ${options.maxConcurrency}`,
				"info",
			);
			let searchDone = 0;
			let lastSearchProgressDone = 0;
			let lastSearchProgressAt = 0;
			const searchCounts = emptyVerdictCounts();
			const searchProgressMessage = () => `/citecheck web-search ${searchDone}/${refsForSearch.length}: ${slug} — ${formatCounts(searchCounts)}`;
			const evidence = await withProgressHeartbeat(
				bridge,
				() => searchProgressMessage(),
				() => checkReferencesWithSearch(
					refsForSearch,
					outDir,
					slug,
					bridge.exec,
					searchScript,
					options.maxConcurrency,
					options.searchTimeoutMs,
					bridge.signal,
					(done, total, reference, itemEvidence) => {
						searchDone = done;
						bridge.ui?.setStatus?.("citecheck", `web-search ${done}/${total}: ${slug}`);
						const verdict = classifyEvidence(reference.entry, itemEvidence);
						searchCounts.total++;
						searchCounts[verdict.verdict]++;
						const now = Date.now();
						if (
							done === 1 ||
							done === total ||
							done - lastSearchProgressDone >= SEARCH_PROGRESS_REF_STEP ||
							now - lastSearchProgressAt >= progressIntervalMs(bridge)
						) {
							lastSearchProgressDone = done;
							lastSearchProgressAt = now;
							emitProgress(bridge, searchProgressMessage(), "info");
						}
					},
				),
			);
			throwIfAborted(bridge.signal);

			checks = refsForSearch.map((reference, index) => {
				const verdict = classifyEvidence(reference.entry, evidence[index]);
				return {
					...reference,
					evidence: evidence[index],
					verdict: verdict.verdict,
					confidence: verdict.confidence,
					reason: verdict.reason,
					discrepancy: verdict.discrepancy,
					evidenceUrls: verdict.evidenceUrls,
				};
			});
		}

		return {
			inputPath: input.path,
			inputKind: input.kind,
			slug,
			outputDir: outDir,
			conversionMode: options.conversion,
			refsOnlyPdf,
			artifacts,
			comparison,
			checks,
			warnings,
			errors,
			startedAt,
			finishedAt: new Date().toISOString(),
		};
	} catch (error) {
		if (isCitecheckAbort(error, bridge.signal)) throw error;
		errors.push(error instanceof Error ? error.message : String(error));
		return {
			inputPath: input.path,
			inputKind: input.kind,
			slug,
			outputDir: outDir,
			conversionMode: options.conversion,
			refsOnlyPdf,
			artifacts,
			checks,
			warnings,
			errors,
			startedAt,
			finishedAt: new Date().toISOString(),
		};
	}
}

async function confirmSearchIfNeeded(count: number, inputPath: string, options: ResolvedOptions, bridge: RunBridge): Promise<void> {
	if (options.yes || !bridge.hasUI || count <= 12) return;
	const ok = await bridge.ui?.confirm?.(
		"Run GPT Web Search checks?",
		`/citecheck found ${count} references in ${inputPath}. This will run one native-web-search request per reference, plus a second request when a claimed citation mismatch needs auditing. Continue?`,
		{ signal: bridge.signal },
	);
	throwIfAborted(bridge.signal);
	if (!ok) throw new Error("User cancelled before GPT Web Search checks.");
}

function emitProgress(bridge: RunBridge, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (bridge.progress) {
		bridge.progress(message, level);
		return;
	}
	bridge.ui?.notify?.(message, level);
}

async function withProgressHeartbeat<T>(
	bridge: RunBridge,
	message: () => string,
	work: () => Promise<T>,
): Promise<T> {
	const intervalMs = progressIntervalMs(bridge);
	if (intervalMs <= 0 || (!bridge.progress && !bridge.ui?.notify)) {
		return work();
	}

	const startedAt = Date.now();
	const timer = setInterval(() => {
		emitProgress(bridge, `${message()} (${formatElapsed(Date.now() - startedAt)} elapsed)`, "info");
	}, intervalMs);
	(timer as { unref?: () => void }).unref?.();

	try {
		return await work();
	} finally {
		clearInterval(timer);
	}
}

function progressIntervalMs(bridge: RunBridge): number {
	const value = bridge.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
	return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_PROGRESS_INTERVAL_MS;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
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

function countsFromChecks(checks: ReferenceCheck[]): Record<Verdict | "total", number> {
	const counts = emptyVerdictCounts();
	for (const check of checks) {
		counts.total++;
		counts[check.verdict]++;
	}
	return counts;
}

function countsFromReports(reports: PaperReport[]): Record<Verdict | "total", number> {
	const counts = emptyVerdictCounts();
	for (const report of reports) {
		const paperCounts = countsFromChecks(report.checks);
		for (const [key, value] of Object.entries(paperCounts) as Array<[Verdict | "total", number]>) {
			counts[key] += value;
		}
	}
	return counts;
}

function formatCounts(counts: Record<Verdict | "total", number>): string {
	const parts = [
		`${counts.total} checked`,
		`valid ${counts.valid}`,
		`likely-valid ${counts["likely-valid"]}`,
		`likely-hallucinated ${counts["likely-hallucinated"]}`,
		`unverified ${counts.unverified}`,
		`needs-review ${counts["needs-manual-review"]}`,
	];
	return parts.join(", ");
}

function formatPaperSummary(report: PaperReport): string {
	const counts = countsFromChecks(report.checks);
	const extra = [];
	if (report.warnings.length > 0) extra.push(`${report.warnings.length} warning(s)`);
	if (report.errors.length > 0) extra.push(`${report.errors.length} error(s)`);
	return `${formatCounts(counts)}${extra.length > 0 ? `; ${extra.join(", ")}` : ""}`;
}

function formatRunSummary(reports: PaperReport[], skippedCount = 0): string {
	const skipped = skippedCount > 0 ? `, ${skippedCount} skipped` : "";
	return `${reports.length} paper(s) processed${skipped}, ${formatCounts(countsFromReports(reports))}.`;
}
