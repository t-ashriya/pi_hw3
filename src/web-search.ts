import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { throwIfAborted } from "./cancel.ts";
import type { CommandInfo, ExecFn, NormalizedReference, ReferenceEntry, SearchEvidence, SearchResult } from "./types.ts";
import { commandExists, ensureDir, truncateForReport, writeText } from "./utils.ts";

export async function locateNativeWebSearch(getCommands?: () => CommandInfo[]): Promise<string | undefined> {
	const commands = getCommands?.() ?? [];
	const candidates: string[] = [];
	for (const command of commands) {
		const path = command.sourceInfo?.baseDir ?? command.sourceInfo?.path;
		if (!path) continue;
		if (command.source === "skill" && command.name.startsWith("native-web-search")) {
			candidates.push(path);
		}
		if (path.includes("native-web-search")) {
			candidates.push(path);
		}
	}

	for (const candidate of candidates) {
		const dir = candidate.endsWith("SKILL.md") ? dirname(candidate) : candidate;
		const script = join(dir, "search.mjs");
		if (existsSync(script)) return script;
	}

	const home = process.env.HOME ?? "";
	const fallbacks = [
		join(home, ".pi/agent/skills/native-web-search/search.mjs"),
		join(home, ".agents/skills/native-web-search/search.mjs"),
		join(home, ".pi/agent/git/github.com/mitsuhiko/agent-stuff/skills/native-web-search/search.mjs"),
	];
	return fallbacks.find((path) => existsSync(path));
}

export async function checkReferencesWithSearch(
	references: Array<{ entry: ReferenceEntry; normalized: NormalizedReference; conversionNotes: string[] }>,
	outDir: string,
	paperSlug: string,
	exec: ExecFn,
	searchScript: string,
	maxConcurrency: number,
	searchTimeoutMs: number,
	signal?: AbortSignal,
	onProgress?: (
		done: number,
		total: number,
		reference: { entry: ReferenceEntry; normalized: NormalizedReference; conversionNotes: string[] },
		evidence: SearchEvidence,
	) => void,
): Promise<SearchEvidence[]> {
	throwIfAborted(signal);
	if (!(await commandExists(exec, "node"))) {
		throwIfAborted(signal);
		throw new Error("node command not found; cannot run native-web-search/search.mjs.");
	}

	const rawDir = join(outDir, "raw-search", paperSlug);
	await ensureDir(rawDir);
	let completed = 0;
	return mapLimit(references, Math.max(1, maxConcurrency), async (reference) => {
		throwIfAborted(signal);
		const evidence = await runOneSearch(reference.entry, reference.normalized, rawDir, exec, searchScript, searchTimeoutMs, signal);
		completed++;
		onProgress?.(completed, references.length, reference, evidence);
		return evidence;
	});
}

async function runOneSearch(
	entry: ReferenceEntry,
	normalized: NormalizedReference,
	rawDir: string,
	exec: ExecFn,
	searchScript: string,
	searchTimeoutMs: number,
	signal?: AbortSignal,
): Promise<SearchEvidence> {
	const query = normalized.query;
	const purpose = buildPurpose(entry, normalized);
	const prefix = join(rawDir, `ref-${String(entry.index).padStart(3, "0")}`);
	throwIfAborted(signal);
	const primary = await executeNativeSearch(query, purpose, exec, searchScript, searchTimeoutMs, signal);
	throwIfAborted(signal);
	const rawSections = [`[primary search]\n${primary.rawText}`];
	let selected = primary;
	let selectedResult: SearchResult["stage"] = "primary";
	const results: SearchResult[] = [{
		stage: "primary",
		query,
		resultText: truncateForReport(primary.resultText),
		exitCode: primary.exitCode,
	}];

	if (primary.exitCode === 0 && needsCitationRecheck(primary.resultText)) {
		const recheckQuery = buildCitationRecheckQuery(entry, normalized, primary.resultText);
		const recheckPurpose = buildCitationRecheckPurpose(entry, primary.resultText);
		const recheck = await executeNativeSearch(recheckQuery, recheckPurpose, exec, searchScript, searchTimeoutMs, signal);
		throwIfAborted(signal);
		rawSections.push(`[citation recheck]\n${recheck.rawText}`);
		results.push({
			stage: "citation-recheck",
			query: recheckQuery,
			resultText: truncateForReport(recheck.resultText),
			exitCode: recheck.exitCode,
		});
		if (recheck.exitCode === 0) {
			selected = recheck;
			selectedResult = "citation-recheck";
		}
	}

	await writeText(`${prefix}.stdout.txt`, rawSections.join("\n\n") + "\n");

	if (primary.exitCode !== 0) {
		return {
			query,
			purpose,
			rawTextPath: `${prefix}.stdout.txt`,
			resultText: truncateForReport(primary.resultText),
			results,
			selectedResult,
			exitCode: primary.exitCode,
			error: `native-web-search failed with exit code ${primary.exitCode}`,
		};
	}

	return {
		query,
		purpose,
		rawTextPath: `${prefix}.stdout.txt`,
		resultText: truncateForReport(selected.resultText),
		results,
		selectedResult,
		exitCode: selected.exitCode,
	};
}

interface NativeSearchRun {
	rawText: string;
	resultText: string;
	exitCode: number;
}

async function executeNativeSearch(
	query: string,
	purpose: string,
	exec: ExecFn,
	searchScript: string,
	searchTimeoutMs: number,
	signal?: AbortSignal,
): Promise<NativeSearchRun> {
	const args = [searchScript, query, "--purpose", purpose, "--provider", "openai-codex", "--json", "--timeout", String(searchTimeoutMs)];
	const result = await exec("node", args, { signal, timeout: searchTimeoutMs + 15_000 });
	const rawText = `${result.stdout || ""}${result.stderr ? `\n\n[stderr]\n${result.stderr}` : ""}`.trim();
	let resultText = rawText;
	try {
		const parsed = JSON.parse(result.stdout || "{}");
		if (typeof parsed.result === "string") resultText = parsed.result;
	} catch {
		// Keep raw stdout/stderr as evidence.
	}
	return { rawText, resultText, exitCode: result.code };
}

function needsCitationRecheck(resultText: string): boolean {
	const verdict = /^\s*(?:[-*]\s*)?verdict\s*:\s*([a-z-]+)/im.exec(resultText)?.[1]?.toLowerCase();
	if (!verdict) return false;
	// A negative structured verdict is itself a claim that deserves an audit.
	// Restricting rechecks to a few phrasings of "field X is wrong" missed
	// false positives whose reason described the disagreement indirectly.
	if (["likely-hallucinated", "unverified", "mismatch"].includes(verdict)) return true;
	const reason = /^\s*(?:[-*]\s*)?reason\s*:\s*(.+)$/im.exec(resultText)?.[1]?.toLowerCase() ?? "";
	const field = "(?:title|authors?|author\\s+(?:list|set)|venue|conference|journal|year|date|doi|pages?|pagination|issue|volume)";
	const discrepancy = "(?:wrong|incorrect|misstates?|mismatch(?:ed)?|do(?:es)?\\s+not\\s+match|fails?\\s+to\\s+match|differs?|different|conflicts?|(?:slightly\\s+)?off|not\\s+(?:the\\s+)?(?:claimed|cited|listed|same|correct)|rather\\s+than)";
	return [
		new RegExp(`\\b${discrepancy}\\b.{0,80}\\b${field}\\b`),
		new RegExp(`\\b${field}\\b.{0,80}\\b${discrepancy}\\b`),
	].some((pattern) => pattern.test(reason));
}

function buildCitationRecheckQuery(entry: ReferenceEntry, normalized: NormalizedReference, primaryResult: string): string {
	const title = normalized.title ? `"${normalized.title}"` : "the cited work";
	const discoveredDois = extractDois(primaryResult);
	const doiEvidence = discoveredDois.length > 0
		? ` Discovered DOI evidence that must be resolved and inspected: ${discoveredDois.map((doi) => `https://doi.org/${doi}`).join(" ")}.`
		: "";
	return `${title} official publication record claimed title authors venue and year.${doiEvidence} Exact citation: ${entry.raw}`;
}

function buildCitationRecheckPurpose(entry: ReferenceEntry, primaryResult: string): string {
	const priorReason = /^\s*(?:[-*]\s*)?reason\s*:\s*(.+)$/im.exec(primaryResult)?.[1]?.trim() ?? "The first search disputed citation metadata.";
	const discoveredDois = extractDois(primaryResult);
	const doiInstructions = discoveredDois.length > 0
		? `\n\nThe first search discovered these DOI identifiers: ${discoveredDois.join(", ")}. Resolve every DOI and inspect its publisher or Crossref metadata before deciding. If that metadata matches the journal citation's title, authors, venue, year, volume, issue, and pages, return valid. Do not treat an earlier arXiv/preprint year or venue as a discrepancy in a matching later formal citation. A stale arXiv or bibliographic-index entry does not disprove a later journal publication. For Crossref, the metadata endpoint is https://api.crossref.org/works/{url-encoded-doi}.`
		: "";
	return `Audit a prior web-search claim about this citation. Search the exact title together with the authors, venue, year, and any cited URL or arXiv identifier stated in the Original reference.${doiInstructions}\n\n${verificationPolicy()}\n\nPrior claim to audit:\n${priorReason}\n\n${VERDICT_RESPONSE_FORMAT}\n\nOriginal reference #${entry.index}:\n${entry.raw}`;
}

function extractDois(text: string): string[] {
	const matches = text.match(/\b10\.\d{4,9}\/[^\s)\]}>"']+/gi) ?? [];
	return [...new Set(matches.map((doi) => doi.replace(/[.,;:]+$/g, "").toLowerCase()))].slice(0, 4);
}

const VERDICT_RESPONSE_FORMAT = `Return exactly this compact structure first:
Verdict: one of valid | likely-valid | unverified | likely-hallucinated | needs-manual-review
Confidence: number from 0 to 1
Reason: one concise sentence
Discrepancy: none, or a concise list in "field: cited value -> verified value" form
Evidence URLs: full URLs separated by spaces`;

function verificationPolicy(): string {
	return `Determine whether the Original reference identifies the publication or online resource it intends to cite. Evaluate the Original reference itself rather than relying on heuristic extracted fields. Search the exact title together with the claimed authors, venue, year, URL, and arXiv identifier when present. Check primary sources first: the cited website, arXiv record, official venue website, publisher proceedings, DOI landing page, or venue OpenReview group. Use bibliographic indexes only as corroboration. Do not infer a mismatch from a missing search result; call an unsupported field unverified unless a reliable source directly contradicts it.

Online-resource rule: A reference marked Online or containing an Available URL need not be a formal paper or bibliographic publication. If the quoted URL, a canonical redirect, or a slightly repaired URL leads to a real page whose owner and subject broadly align with what is quoted, return valid or likely-valid. Treat line-wrap spaces, tracking parameters, nearby product/catalog URLs, modest page-title wording, corporate-author labels, and access/publication dates as benign. Use likely-hallucinated for a URL citation only when the URL or target is fabricated or grossly different from the quoted resource, not merely because it is a product, documentation, support, marketing, or catalog page.

arXiv-version rule: When the reference cites an arXiv identifier, verify that identifier on arxiv.org. If the identifier resolves to the same work, return valid even if the work also appeared later or elsewhere at a conference, workshop, or journal. If the same work is established but the arXiv identifier cannot be confirmed or is inaccurate, return likely-valid when the remaining issue is only arXiv/preprint versus conference or journal version metadata. A conference version does not make a correct arXiv citation's venue wrong.

Formal-version rule: When the Original reference cites a formal journal or conference version and its publisher or DOI metadata matches, return valid. An earlier preprint of the same work can have a different year and venue; those preprint fields are not discrepancies in the later formal citation and must not lower its verdict.

Omitted-field rule: A venue that is absent from the Original reference is incomplete metadata, not a venue mismatch. When reliable sources confirm the exact title and authors and the remaining difference is only a nearby year/date or another secondary field, return likely-valid. Never infer a contradictory venue from a field the citation did not claim.

For ordinary publication citations outside those rules, verify title, author identity/list, and any venue actually asserted by the citation. A workshop copy, preprint, author page, or repository copy can coexist with a conference or journal publication and does not disprove the claimed venue. Treat initials versus full given names, abbreviated venues, minor punctuation/hyphenation differences, and an author list shortened with et al. as valid when they identify the same work. Outside the special rules above, a demonstrated material mismatch in one asserted core field—title OR authors OR venue—may be likely-hallucinated. Errors limited to year, date, DOI, issue, volume, or pages—including a publication year off by one and prepublication pages such as 1–16—are minor secondary-metadata discrepancies and must be likely-valid when the title, authors, and any asserted venue identify the same work. Reserve likely-hallucinated for a gross identity conflict or strong evidence of fabrication. Sparse evidence without a demonstrated mismatch requires unverified or needs-manual-review.`;
}

function buildPurpose(entry: ReferenceEntry, normalized: NormalizedReference): string {
	const fields = [
		normalized.title ? `Title: ${normalized.title}` : undefined,
		normalized.authors ? `Authors: ${normalized.authors}` : undefined,
		normalized.year ? `Year: ${normalized.year}` : undefined,
		normalized.doi ? `DOI: ${normalized.doi}` : undefined,
		normalized.url ? `URL: ${normalized.url}` : undefined,
		normalized.arxivId ? `arXiv: ${normalized.arxivId}` : undefined,
	]
		.filter(Boolean)
		.join("\n");

	return `${verificationPolicy()}\n\n${VERDICT_RESPONSE_FORMAT}\n\nOriginal reference #${entry.index}:\n${entry.raw}\n\nHeuristic extracted fields, which may be incomplete and should not by themselves cause a negative verdict:\n${fields || "No reliable fields extracted."}`;
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function readSearchEvidence(path: string): Promise<string> {
	return readFile(path, "utf8");
}
