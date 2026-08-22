import type { NormalizedReference, ReferenceEntry } from "./types.ts";
import { firstLine } from "./utils.ts";

const DOI_RE = /\b10\.\d{4,9}\/[\w.()/:;\-]+/i;
const URL_RE = /https?:\/\/[^\s)\]>]+/i;
const ARXIV_RE = /\barXiv\s*:?\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:\s*\[[^\]]+\])?/i;
const YEAR_RE = /\b(19|20)\d{2}[a-z]?\b/;

export function normalizeReference(entry: ReferenceEntry): NormalizedReference {
	const raw = entry.raw;
	const doi = cleanDoi(DOI_RE.exec(raw)?.[0]);
	const url = cleanUrl(URL_RE.exec(raw)?.[0]);
	const arxivId = ARXIV_RE.exec(raw)?.[1];
	const year = YEAR_RE.exec(raw)?.[0];
	const title = extractTitle(raw);
	const authors = extractAuthors(raw, title, year);
	const query = buildSearchQuery(raw, { title, authors, year, doi, arxivId });
	return { title, authors, year, doi, url, arxivId, query };
}

function cleanDoi(doi: string | undefined): string | undefined {
	if (!doi) return undefined;
	return doi.replace(/[).,;:]+$/g, "");
}

function cleanUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return url.replace(/[).,;:]+$/g, "");
}

function extractTitle(raw: string): string | undefined {
	const doubleQuoted = /["“](.{8,240}?)["”]/.exec(raw);
	if (doubleQuoted) return cleanTitle(doubleQuoted[1]);

	const singleQuoted = /(?:^|[\s,.;:])['‘]([^'‘’]{8,240}?)['’](?=[\s,.;:)]|$)/.exec(raw);
	if (singleQuoted) return cleanTitle(singleQuoted[1]);

	const withoutPrefix = raw.replace(/^\s*\[?\d{1,4}\]?\s*[.)]?\s*/, "");
	const apa = /\((?:19|20)\d{2}[a-z]?\)\.\s+(.+?)\.\s+/.exec(withoutPrefix);
	if (apa) return cleanTitle(apa[1]);

	const segments = withoutPrefix
		.split(/\.\s+/)
		.map((segment) => segment.trim())
		.filter(Boolean);

	for (const segment of segments) {
		const candidate = segment.replace(/^\((?:19|20)\d{2}[a-z]?\)\s*/, "").trim();
		if (looksLikeTitle(candidate)) return cleanTitle(candidate);
	}

	const commaQuote = /,\s*([^,]{20,180}?),\s*(?:in\s+)?(?:Proc\.|Proceedings|Journal|IEEE|ACM|arXiv|CoRR)/i.exec(withoutPrefix);
	if (commaQuote) return cleanTitle(commaQuote[1]);

	return undefined;
}

function looksLikeTitle(value: string): boolean {
	if (value.length < 12 || value.length > 240) return false;
	if (/\b(?:journal|proceedings|transactions|conference|symposium|workshop|press|vol\.|no\.|pp\.)\b/i.test(value)) {
		return false;
	}
	const words = value.split(/\s+/).filter(Boolean);
	if (words.length < 3) return false;
	const initialish = words.filter((word) => /^[A-Z]\.?$/.test(word) || /^[A-Z][a-z]+,?$/.test(word)).length;
	return initialish / words.length < 0.85;
}

function cleanTitle(title: string | undefined): string | undefined {
	if (!title) return undefined;
	const cleaned = title
		.replace(/^["“”'‘’]+|["“”'‘’.,]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length >= 8 ? cleaned : undefined;
}

function extractAuthors(raw: string, title: string | undefined, year: string | undefined): string | undefined {
	let end = raw.length;
	if (title) {
		const idx = raw.toLowerCase().indexOf(title.toLowerCase());
		if (idx > 0) end = idx;
	}
	if (year) {
		const idx = raw.indexOf(year);
		if (idx > 0) end = Math.min(end, idx);
	}
	let prefix = raw.slice(0, Math.min(end, 260));
	prefix = prefix.replace(/^\s*\[?\d{1,4}\]?\s*[.)]?\s*/, "");
	prefix = prefix.replace(/\(\s*$/, "").replace(/[.,;'‘’\s]+$/g, "").trim();
	if (prefix.length < 2) return undefined;
	if (prefix.length > 220) prefix = prefix.slice(0, 220).replace(/[,;]\s*[^,;]*$/, "");
	return prefix || undefined;
}

function buildSearchQuery(
	raw: string,
	parts: Pick<NormalizedReference, "title" | "authors" | "year" | "doi" | "arxivId">,
): string {
	if (parts.doi) return `Official publication record for DOI ${parts.doi}. Claimed citation: ${firstLine(raw, 320)}`;
	if (parts.arxivId) return `Official publication record for arXiv ${parts.arxivId}. Claimed citation: ${firstLine(raw, 320)}`;
	const chunks: string[] = [];
	if (parts.title) chunks.push(`"${parts.title}"`);
	if (parts.authors) chunks.push(firstAuthorLastName(parts.authors));
	if (parts.year) chunks.push(parts.year.replace(/[a-z]$/i, ""));
	if (chunks.length >= 2) {
		return `Official publication record for ${chunks.filter(Boolean).join(" ")}. Claimed citation: ${firstLine(raw, 320)}`;
	}
	return firstLine(raw, 280);
}

function firstAuthorLastName(authors: string): string {
	const first = authors.split(/\s+(?:and|&)\s+|;/i)[0] ?? authors;
	const comma = first.split(",")[0]?.trim();
	if (comma) return comma;
	const words = first.trim().split(/\s+/);
	return words[words.length - 1] ?? first.trim();
}
