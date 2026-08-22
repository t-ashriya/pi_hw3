import type { ReferenceEntry, SearchEvidence, Verdict } from "./types.ts";
import { unique } from "./utils.ts";

type ParsedVerdict = Verdict | "mismatch";

interface ClassificationResult {
	verdict: Verdict;
	confidence: number;
	reason: string;
	evidenceUrls: string[];
}

export interface VerdictResult extends ClassificationResult {
	discrepancy: string;
}

export function classifyEvidence(entry: ReferenceEntry, evidence: SearchEvidence | undefined): VerdictResult {
	const result = classifyEvidenceCore(entry, evidence);
	return {
		...result,
		discrepancy: describeDiscrepancy(evidence?.resultText, result),
	};
}

function classifyEvidenceCore(entry: ReferenceEntry, evidence: SearchEvidence | undefined): ClassificationResult {
	if (!evidence || evidence.error) {
		return {
			verdict: "needs-manual-review",
			confidence: 0.2,
			reason: evidence?.error ?? "No search evidence was collected.",
			evidenceUrls: [],
		};
	}

	const text = evidence.resultText.trim();
	const parsedVerdict = parseVerdict(text);
	const parsedConfidence = parseConfidence(text);
	const urls = extractUrls(text);
	const reason = parseReason(text) ?? summarizeReason(text, entry.raw);

	const arxivVersionVerdict = classifyArxivVersionCitation(entry, text, reason, parsedVerdict, parsedConfidence, urls);
	if (arxivVersionVerdict) return arxivVersionVerdict;

	const onlineResourceVerdict = classifyOnlineResourceCitation(entry, text, reason, parsedVerdict, parsedConfidence, urls);
	if (onlineResourceVerdict) return onlineResourceVerdict;

	const formalPublicationVerdict = classifyExactFormalPublication(entry, reason, parsedVerdict, parsedConfidence, urls);
	if (formalPublicationVerdict) return formalPublicationVerdict;

	const secondaryMetadataVerdict = classifySecondaryMetadataOnlyMismatch(entry, text, reason, parsedConfidence, urls);
	if (secondaryMetadataVerdict) return secondaryMetadataVerdict;

	if (looksLikeMaterialCitationMismatch(reason.toLowerCase()) || looksLikeCoreIdentityConflict(reason.toLowerCase())) {
		return {
			verdict: "likely-hallucinated",
			confidence: parsedConfidence ?? defaultConfidence("likely-hallucinated"),
			reason,
			evidenceUrls: urls,
		};
	}

	if (parsedVerdict) {
		if (parsedVerdict === "mismatch") {
			return classifyLegacyMismatch(text, reason, parsedConfidence, urls);
		}
		return {
			verdict: parsedVerdict,
			confidence: parsedConfidence ?? defaultConfidence(parsedVerdict),
			reason,
			evidenceUrls: urls,
		};
	}

	const lower = text.toLowerCase();
	if (looksLikeMaterialCitationMismatch(lower) || looksLikeCoreIdentityConflict(lower)) {
		return { verdict: "likely-hallucinated", confidence: parsedConfidence ?? 0.78, reason, evidenceUrls: urls };
	}
	if (looksLikelyHallucinated(lower)) {
		return { verdict: "likely-hallucinated", confidence: parsedConfidence ?? 0.8, reason, evidenceUrls: urls };
	}
	if (looksUnverified(lower)) {
		return { verdict: "unverified", confidence: parsedConfidence ?? 0.55, reason, evidenceUrls: urls };
	}
	if (looksLikeRealWork(lower) && urls.length > 0) {
		return { verdict: "likely-valid", confidence: parsedConfidence ?? 0.72, reason, evidenceUrls: urls };
	}
	return { verdict: "needs-manual-review", confidence: parsedConfidence ?? 0.4, reason, evidenceUrls: urls };
}

/**
 * Older prompts offered `mismatch` as a verdict. Preserve compatibility with
 * cached/raw responses without exposing that category in reports. A real work
 * with imperfect secondary metadata is likely-valid. A material title, author,
 * or venue mismatch is handled as likely-hallucinated before this function.
 */
function classifyLegacyMismatch(
	text: string,
	reason: string,
	confidence: number | undefined,
	evidenceUrls: string[],
): ClassificationResult {
	const lowerReason = reason.toLowerCase();
	const lowerText = text.toLowerCase();
	if (looksLikelyHallucinated(lowerReason)) {
		return {
			verdict: "likely-hallucinated",
			confidence: confidence ?? defaultConfidence("likely-hallucinated"),
			reason,
			evidenceUrls,
		};
	}
	if (looksLikeCoreIdentityConflict(lowerReason) || looksUnverified(lowerReason)) {
		return {
			verdict: "unverified",
			confidence: confidence ?? defaultConfidence("unverified"),
			reason,
			evidenceUrls,
		};
	}
	if (looksLikeRealWork(lowerReason) || looksLikeRealWork(lowerText)) {
		return {
			verdict: "likely-valid",
			confidence: confidence ?? defaultConfidence("likely-valid"),
			reason: `The cited work appears to be real; bibliographic discrepancies are retained as notes: ${reason}`,
			evidenceUrls,
		};
	}
	return {
		verdict: "needs-manual-review",
		confidence: confidence ?? defaultConfidence("needs-manual-review"),
		reason: `The search returned the obsolete mismatch category without clearly establishing whether the cited work exists: ${reason}`,
		evidenceUrls,
	};
}

function classifyExactFormalPublication(
	entry: ReferenceEntry,
	reason: string,
	parsedVerdict: ParsedVerdict | undefined,
	confidence: number | undefined,
	evidenceUrls: string[],
): ClassificationResult | undefined {
	if (parsedVerdict !== "likely-valid" || extractCitedArxivId(entry.raw)) return undefined;
	if (!evidenceUrls.some((url) => /(?:doi\.org\/10\.|\/doi\/10\.)/i.test(url))) return undefined;

	const lowerReason = reason.toLowerCase();
	const exactCoreMatch = /\b(?:publisher|doi|journal|acm|ieee)\b.{0,80}\b(?:confirms?|matches?)\b.{0,60}\bexact\s+title\b.{0,80}\bauthor(?:s|\s+list|\s+set)?\b.{0,80}\bvenue\b/.test(lowerReason) ||
		/\b(?:confirms?|matches?)\b.{0,60}\bexact\s+title\b.{0,80}\bauthor(?:s|\s+list|\s+set)?\b.{0,80}\bvenue\b/.test(lowerReason);
	if (!exactCoreMatch || looksLikeCoreIdentityConflict(lowerReason)) return undefined;

	const citedYears = new Set(entry.raw.match(/\b(?:19|20)\d{2}\b/g) ?? []);
	const formalPublicationYears = extractFormalPublicationYears(reason);
	if (citedYears.size > 0 && !formalPublicationYears.some((year) => citedYears.has(year))) return undefined;

	return {
		verdict: "valid",
		confidence: confidence ?? defaultConfidence("valid"),
		reason: `Publisher/DOI evidence confirms the cited formal publication's title, authors, venue, and year: ${reason}`,
		evidenceUrls,
	};
}

function extractFormalPublicationYears(text: string): string[] {
	const years: string[] = [];
	for (const pattern of [
		/\b((?:19|20)\d{2})\s+(?:formal\s+)?publication\s+(?:date|year)\b/gi,
		/\b(?:publication\s+(?:date|year)|published(?:\s+(?:online|in))?)\D{0,24}((?:19|20)\d{2})\b/gi,
	]) {
		for (const match of text.matchAll(pattern)) {
			if (match[1]) years.push(match[1]);
		}
	}
	return unique(years);
}

function classifySecondaryMetadataOnlyMismatch(
	entry: ReferenceEntry,
	text: string,
	reason: string,
	confidence: number | undefined,
	evidenceUrls: string[],
): ClassificationResult | undefined {
	const lowerReason = reason.toLowerCase();
	const lowerText = text.toLowerCase();
	const venueOmitted = referenceOmitsClaimedVenue(entry.raw);
	const identityConfirmed = confirmsSameCitationIdentity(lowerReason) || confirmsSameCitationIdentity(lowerText);
	const explicitlySecondaryOnly = [
		/\b(?:only|main|remaining|sole|clear)\s+(?:issue|difference|discrepancy|mismatch)\b.{0,80}\bsecondary\s+(?:bibliographic\s+)?metadata\b/,
		/\bsecondary[-\s]metadata\s+(?:difference|discrepancy|mismatch)\b/,
		/\bsecondary[-\s](?:field|metadata)\s+(?:difference|discrepancy|mismatch|error|issue)s?\b/,
		/\b(?:difference|discrepancy|mismatch)\b.{0,40}\b(?:is|are)\s+(?:only\s+)?(?:minor\s+)?secondary\s+(?:bibliographic\s+)?metadata\b/,
		/\b(?:only|main|remaining|sole|clear)\s+(?:issue|difference|discrepancy|mismatch)\b.{0,100}\b(?:year|date|pages?|page\s+range|pagination|volume|issue|doi)\b/,
		/\bminor\s+(?:publication\s+)?timing\s+difference\b/,
		/\bminor\s+(?:bibliographic\s+|secondary\s+)?metadata\s+(?:difference|discrepancy|error|issue)s?\b/,
		/\b(?:et\s+al\.?|page\s+span|page\s+format(?:ting)?|transliteration\s+variant)\b.{0,100}\bminor\s+(?:bibliographic\s+|secondary\s+)?metadata\b/,
		/\btransliteration\s+variant\b.{0,100}\b(?:not|rather\s+than)\b.{0,40}\b(?:identity\s+conflict|author\s+mismatch)\b/,
	].some((pattern) => pattern.test(lowerReason));
	const yearOrPagesOff = /\b(?:year|date|pages?|page\s+range|pagination)\b.{0,80}\b(?:off|wrong|incorrect|differ|differs|mismatch|discrepancy|rather\s+than)\b/.test(lowerReason) ||
		/\b(?:off|wrong|incorrect|different|mismatched)\b.{0,80}\b(?:year|date|pages?|page\s+range|pagination)\b/.test(lowerReason) ||
		/\b(?:year|date|pages?|page\s+range|pagination)\b.{0,80}\b(?:inconsistent|timing\s+difference|secondary[-\s]field\s+error)\b/.test(lowerReason);

	if (
		!identityConfirmed ||
		looksLikelyHallucinated(lowerReason) ||
		looksLikeCoreIdentityConflict(lowerReason) ||
		looksLikeTitleOrAuthorConflict(lowerReason)
	) return undefined;
	// An explicit statement that the only problem is secondary metadata takes
	// precedence over broad word-proximity checks. For example, "journal record
	// ... different page range" contains both "journal" and "different" but is
	// not a venue mismatch.
	if (!explicitlySecondaryOnly && (!yearOrPagesOff || (looksLikeMaterialCitationMismatch(lowerReason) && !venueOmitted))) return undefined;
	return {
		verdict: "likely-valid",
		confidence: confidence ?? defaultConfidence("likely-valid"),
		reason: venueOmitted
			? `The title and authors identify the same work; the venue was omitted rather than contradicted, and the reported year/date difference is minor secondary metadata: ${reason}`
			: `The title, authors, and venue identify the same work; the reported year, date, volume, issue, DOI, or page differences are minor secondary metadata: ${reason}`,
		evidenceUrls,
	};
}

function referenceOmitsClaimedVenue(raw: string): boolean {
	const quotedTitle = /["“][^"”]{8,}["”]/.exec(raw) ?? /['‘][^'’]{8,}['’]/.exec(raw);
	if (!quotedTitle || quotedTitle.index === undefined) return false;
	const suffix = raw.slice(quotedTitle.index + quotedTitle[0].length)
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/\bdoi\s*:?\s*10\.\S+/gi, " ")
		.replace(/\b(?:19|20)\d{2}[a-z]?\b/gi, " ")
		.replace(/\b(?:vol(?:ume)?|no|number|pp?|pages?|article|art)\.?\s*[\d\s:–—-]*/gi, " ")
		.replace(/\b(?:early\s+access|accessed|retrieved)\b/gi, " ")
		.replace(/[\d\s,.;:()[\]{}–—-]+/g, " ");
	return !/[a-z]/i.test(suffix);
}

function confirmsSameCitationIdentity(text: string): boolean {
	return looksLikeRealWork(text) || [
		/\b(?:same|exact|matching)\s+(?:paper|work|publication|article|paper\s+title)\b/,
		/\b(?:identify|identifies|confirm|confirms|match|matches|matching)\b.{0,100}\b(?:same\s+)?(?:paper|work|publication|article|title|authors?|author\s+(?:set|list))\b/,
		/\b(?:title|authors?|author\s+(?:set|list))\b.{0,100}\b(?:match|matches|matching|align|aligns|same|exact|confirm|confirms)\b/,
	].some((pattern) => pattern.test(text));
}

function classifyArxivVersionCitation(
	entry: ReferenceEntry,
	text: string,
	reason: string,
	parsedVerdict: ParsedVerdict | undefined,
	confidence: number | undefined,
	evidenceUrls: string[],
): ClassificationResult | undefined {
	const arxivId = extractCitedArxivId(entry.raw);
	if (!arxivId) return undefined;

	const lower = text.toLowerCase();
	const lowerReason = reason.toLowerCase();
	const titleOrAuthorConflict = looksLikeTitleOrAuthorConflict(lowerReason);
	const differentWorkConflict = looksLikeCoreIdentityConflict(lowerReason);
	const sameWork = looksLikeRealWork(lower) || [
		/\b(?:same|exact)\s+title\b/,
		/\btitle\s+and\s+author(?:s|\s+list|\s+set)?\b.{0,80}\b(?:match|matches|matching|align|aligns|same|exact)\b/,
		/\b(?:match|matches|matching|align|aligns)\b.{0,80}\btitle\s+and\s+author(?:s|\s+list|\s+set)?\b/,
		/\barxiv\b.{0,100}\b(?:same\s+work|same\s+paper|preprint\s+(?:exists|record)|record\s+(?:exists|matches|confirms))\b/,
	].some((pattern) => pattern.test(lower));
	const idInEvidenceUrl = evidenceUrls.some((url) => extractArxivId(url) === arxivId);
	const escapedId = escapeRegex(arxivId);
	const idConfirmedByText = [
		new RegExp(`\\barxiv(?:\\s+(?:id|identifier|record))?\\s*[:#]?\\s*${escapedId}\\b.{0,100}\\b(?:correct|valid|real|exists|matches|same\\s+(?:work|paper)|confirms)\\b`),
		new RegExp(`\\b(?:correct|valid|real|confirmed|matching)\\b.{0,100}\\barxiv(?:\\s+(?:id|identifier|record))?\\s*[:#]?\\s*${escapedId}\\b`),
	].some((pattern) => pattern.test(lower));
	const explicitIdConflict = [
		new RegExp(`\\barxiv(?:\\s+(?:id|identifier|number|record))?\\s*[:#]?\\s*${escapedId}\\b.{0,100}\\b(?:wrong|incorrect|unrelated|different\\s+(?:paper|work)|does\\s+not\\s+match)\\b`),
		/\b(?:wrong|incorrect|mismatched)\s+arxiv\s+(?:id|identifier|number)\b/,
		/\barxiv\s+(?:id|identifier|number)\b.{0,80}\b(?:wrong|incorrect|points?\s+to\s+(?:an?\s+)?(?:unrelated|different))\b/,
	].some((pattern) => pattern.test(lowerReason));
	const versionOrVenueDifference = /\b(?:arxiv|preprint)\b/.test(lower) &&
		/\b(?:conference|journal|proceedings|venue|published|publication|version)\b/.test(lower) &&
		/\b(?:later|instead|rather\s+than|versus|vs\.?|mismatch|difference|differs?|published|appears?\s+(?:at|in)|publication\s+is\s+(?:at|in)|place[sd]?\s+the\s+work)\b/.test(lower);

	if (!titleOrAuthorConflict && !differentWorkConflict && !explicitIdConflict && sameWork && (idInEvidenceUrl || idConfirmedByText)) {
		return {
			verdict: "valid",
			confidence: confidence ?? defaultConfidence("valid"),
			reason: `The cited arXiv identifier ${arxivId} resolves to the same work; a conference or journal version does not invalidate the arXiv citation.`,
			evidenceUrls,
		};
	}

	if (!titleOrAuthorConflict && !differentWorkConflict && sameWork && versionOrVenueDifference) {
		return {
			verdict: "likely-valid",
			confidence: confidence ?? defaultConfidence("likely-valid"),
			reason: `The cited work is real; the remaining discrepancy concerns its arXiv/preprint versus conference or journal version${explicitIdConflict ? ", including the arXiv identifier" : ""}.`,
			evidenceUrls,
		};
	}

	if (parsedVerdict === "valid" && !titleOrAuthorConflict && !differentWorkConflict) {
		return { verdict: "valid", confidence: confidence ?? defaultConfidence("valid"), reason, evidenceUrls };
	}
	return undefined;
}

function classifyOnlineResourceCitation(
	entry: ReferenceEntry,
	text: string,
	reason: string,
	parsedVerdict: ParsedVerdict | undefined,
	confidence: number | undefined,
	evidenceUrls: string[],
): ClassificationResult | undefined {
	if (!/\b(?:online|available)\b/i.test(entry.raw) || !/https?\s*:\s*\/\//i.test(entry.raw)) return undefined;

	const lower = text.toLowerCase();
	const lowerReason = reason.toLowerCase();
	const grossConflict = /\b(?:unrelated|grossly\s+different|entirely\s+different|fabricated|invented)\b.{0,80}\b(?:url|page|site|resource|product|subject|domain)\b/.test(lowerReason) ||
		/\b(?:url|page|site|resource|product|subject|domain)\b.{0,80}\b(?:unrelated|grossly\s+different|entirely\s+different|fabricated|invented)\b/.test(lowerReason) ||
		/\burl\b.{0,80}\bpoints?\s+to\s+(?:an?\s+)?unrelated\b/.test(lowerReason);
	if (grossConflict) return undefined;

	const citedUrls = extractCitationUrls(entry.raw);
	const closeness = closestUrlMatch(citedUrls, evidenceUrls);
	if (closeness === "none") return undefined;

	const confirmsOnlineResource = [
		/\b(?:cited|quoted|provided)\s+url\b.{0,100}\b(?:real|official|exists|resolves?|points?|page)\b/,
		/\burl\b.{0,80}\b(?:real|official|exists|resolves?|points?|product|marketing|documentation|support|catalog|website|web|function\s+reference)\b/,
		/\b(?:real|official|existing|live)\b.{0,80}\b(?:product|marketing|documentation|support|catalog|website|web|function\s+reference)?\s*page\b/,
		/\b(?:primary(?:\s+\w+){0,3}\s+sources?|cited\s+(?:item|source)|url\s+target)\b.{0,100}\b(?:product|marketing|documentation|support|catalog|website|web|function\s+reference)\b/,
		/\b(?:product(?:\/marketing)?|marketing|documentation|support|catalog|website|web|function\s+reference)\s+page\b/,
	].some((pattern) => pattern.test(lower));
	if (!confirmsOnlineResource) return undefined;

	if (parsedVerdict === "valid") {
		return {
			verdict: "valid",
			confidence: confidence ?? defaultConfidence("valid"),
			reason: "The cited online resource exists at the quoted or canonically equivalent URL and its subject aligns with the reference.",
			evidenceUrls,
		};
	}
	return {
		verdict: "likely-valid",
		confidence: confidence ?? defaultConfidence("likely-valid"),
		reason: closeness === "same-target"
			? "The cited online resource exists at the quoted or canonically equivalent URL; minor page-title, attribution, date, or publication-format differences do not make it hallucinated."
			: "The cited online resource is corroborated by a closely related URL on the same official site; the URL or page-label differences are not gross enough to make it hallucinated.",
		evidenceUrls,
	};
}

function extractCitedArxivId(raw: string): string | undefined {
	const match = /\barxiv(?:\s+preprint)?(?:\s+arxiv)?\s*[:#]?\s*([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?\b/i.exec(raw);
	return match?.[1]?.toLowerCase();
}

function extractArxivId(text: string): string | undefined {
	const match = /(?:arxiv\.org\/(?:abs|pdf)\/|\barxiv(?:\s+(?:id|identifier|record))?\s*[:#]?\s*)([a-z-]+(?:\.[a-z-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(text);
	return match?.[1]?.toLowerCase();
}

function looksLikeTitleOrAuthorConflict(text: string): boolean {
	return citationConflictClauses(text).some((clause) => {
		if (negatesIdentityConflict(clause)) return false;
		return [
			/\b(?:title|authors?|author\s+(?:list|set))\b.{0,80}\b(?:is\s+wrong|are\s+wrong|is\s+incorrect|are\s+incorrect|do(?:es)?\s+not\s+match|fails?\s+to\s+match|materially\s+differs?|unrelated)\b/,
			/\b(?:wrong|incorrect|mismatched|unrelated)\s+(?:cited\s+|claimed\s+)?(?:title|authors?|author\s+(?:list|set))\b/,
		].some((pattern) => pattern.test(clause));
	});
}

function extractCitationUrls(raw: string): string[] {
	const starts = [...raw.matchAll(/https?\s*:\s*\/\//gi)];
	return starts.map((match) => {
		const start = match.index ?? 0;
		return raw
			.slice(start)
			.split(/\s+(?=(?:accessed|retrieved|doi|arxiv)\b)/i, 1)[0]!
			.replace(/\s+/g, "")
			.replace(/&amp;/gi, "&")
			.replace(/[.,;:]+$/g, "");
	});
}

type UrlCloseness = "same-target" | "same-site" | "none";

function closestUrlMatch(citedUrls: string[], evidenceUrls: string[]): UrlCloseness {
	let sameSite = false;
	for (const cited of citedUrls) {
		const citedParts = comparableUrl(cited);
		if (!citedParts) continue;
		for (const evidence of evidenceUrls) {
			const evidenceParts = comparableUrl(evidence);
			if (!evidenceParts) continue;
			if (citedParts.site !== evidenceParts.site) continue;
			sameSite = true;
			if (citedParts.host === evidenceParts.host && citedParts.path === evidenceParts.path) return "same-target";
		}
	}
	return sameSite ? "same-site" : "none";
}

function comparableUrl(value: string): { host: string; site: string; path: string } | undefined {
	try {
		const parsed = new URL(value);
		const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
		const labels = host.split(".");
		const site = labels.slice(-2).join(".");
		const path = parsed.pathname.replace(/\/+$/g, "").toLowerCase() || "/";
		return { host, site, path };
	} catch {
		return undefined;
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeRealWork(text: string): boolean {
	return [
		/\b(?:paper|work|publication|article)\s+(?:clearly\s+)?(?:is|appears\s+to\s+be|seems\s+to\s+be)\s+real\b/,
		/\b(?:paper|work|publication|article)\s+(?:clearly\s+)?exists\b/,
		/\b(?:reference|citation)\s+(?:matches|corresponds\s+to|points\s+to)\s+(?:an?\s+)?(?:real|actual|existing)\s+(?:paper|work|publication|article)\b/,
		/\b(?:matches|corresponds\s+to)\s+(?:an?\s+)?(?:real|actual|existing)\s+(?:paper|work|publication|article)\b/,
		/\b(?:title|authors?|author\s+set)\b.{0,80}\b(?:match|matches|align|aligns|confirmed|verified)\b/,
		/\b(?:matches|aligns)\b.{0,80}\b(?:title|authors?|author\s+set)\b/,
	].some((pattern) => pattern.test(text));
}

function looksLikeCoreIdentityConflict(text: string): boolean {
	return citationConflictClauses(text).some((clause) => {
		if (negatesIdentityConflict(clause)) return false;
		return [
			/\btitle\b.{0,60}\b(?:differs?\s+materially|materially\s+differs?|does\s+not\s+match)\b/,
			/\bpoints?\s+to\s+(?:an?\s+)?(?:different|wrong|unrelated)\s+(?:paper|work)\b/,
			/\b(?:identifies|is|was)\s+(?:an?\s+)?(?:different|wrong|unrelated)\s+(?:paper|work)\b/,
		].some((pattern) => pattern.test(clause));
	});
}

function looksLikeMaterialCitationMismatch(text: string): boolean {
	const field = "(?:title|authors?|author\\s+(?:list|set)|venue|conference|journal)";
	const discrepancy = "(?:is\\s+wrong|are\\s+wrong|was\\s+wrong|were\\s+wrong|is\\s+incorrect|are\\s+incorrect|mismatch(?:ed)?|do(?:es)?\\s+not\\s+match|fails?\\s+to\\s+match|failed\\s+to\\s+match|differs?\\s+materially|materially\\s+differs?|conflicts?\\s+with|contradicts?)";
	return citationConflictClauses(text).some((clause) => {
		if (negatesIdentityConflict(clause)) return false;
		return [
			new RegExp(`\\b${field}\\b.{0,80}\\b${discrepancy}\\b`),
			new RegExp(`\\b(?:wrong|incorrect|mismatched)\\s+(?:cited\\s+|claimed\\s+|original\\s+)?${field}\\b`),
			/\b(?:reference|citation)\b.{0,60}\bmisstates?\b.{0,30}\b(?:title|authors?|venue|conference|journal)\b/,
		].some((pattern) => pattern.test(clause));
	});
}

function citationConflictClauses(text: string): string[] {
	return text.split(/[.;]|\bbut\b|\bhowever\b/).map((clause) => clause.trim()).filter(Boolean);
}

function negatesIdentityConflict(clause: string): boolean {
	return [
		/\b(?:not|rather\s+than)\s+(?:an?\s+)?(?:different|wrong|unrelated)\s+(?:paper|work)\b/,
		/\b(?:not|rather\s+than)\s+(?:an?\s+)?(?:core\s+)?identity\s+conflict\b/,
		/\b(?:no|not|without)\s+(?:an?\s+)?(?:title|author|venue|identity)?\s*(?:mismatch|conflict)\b/,
		/\b(?:title|authors?|author\s+(?:list|set)|venue)\b.{0,40}\b(?:is|are|was|were)\s+not\s+(?:wrong|incorrect|mismatched|unrelated)\b/,
		/\b(?:avoid(?:s|ed|ing)?|nothing\s+suggests?)\b.{0,60}\b(?:mismatch|conflict|wrong|incorrect)\b/,
	].some((pattern) => pattern.test(clause));
}

function looksLikelyHallucinated(text: string): boolean {
	const normalized = text
		.replace(/\b(?:not|rather\s+than)\s+likely[-\s]hallucinated\b/g, "")
		.replace(/\b(?:not|rather\s+than)\s+(?:fabricated|invented|nonexistent)\b/g, "");
	return /\b(likely[-\s]hallucinated|fabricated|not a real publication|appears invented|appears fabricated|nonexistent (?:paper|work|publication|article))\b/.test(normalized);
}

function looksUnverified(text: string): boolean {
	return /\b(could not find|no reliable evidence|not found|unable to verify|no matching publication|insufficient evidence)\b/.test(text);
}

function parseVerdict(text: string): ParsedVerdict | undefined {
	const match = /^\s*(?:[-*]\s*)?verdict\s*:\s*([a-z-]+)/im.exec(text);
	const value = match?.[1]?.toLowerCase();
	switch (value) {
		case "valid":
		case "likely-valid":
		case "mismatch":
		case "unverified":
		case "likely-hallucinated":
		case "needs-manual-review":
			return value;
		default:
			return undefined;
	}
}

function parseConfidence(text: string): number | undefined {
	const match = /^\s*(?:[-*]\s*)?confidence\s*:\s*([01](?:\.\d+)?|\d{1,3}%)/im.exec(text);
	if (!match) return undefined;
	const raw = match[1]!;
	const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
	if (!Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

function parseReason(text: string): string | undefined {
	const match = /^\s*(?:[-*]\s*)?reason\s*:\s*(.+)$/im.exec(text);
	return match?.[1]?.trim();
}

function parseDiscrepancy(text: string): string | undefined {
	const match = /^\s*(?:[-*]\s*)?discrepancy\s*:\s*(.+)$/im.exec(text);
	return match?.[1]?.trim();
}

function describeDiscrepancy(text: string | undefined, result: ClassificationResult): string {
	const explicit = text ? parseDiscrepancy(text) : undefined;
	if (explicit && !/^(?:none|no\s+(?:discrepancy|difference)s?)(?:[.!]|$)/i.test(explicit)) return explicit;

	switch (result.verdict) {
		case "valid":
			return "None found.";
		case "likely-valid":
			return result.reason;
		case "likely-hallucinated":
			return result.reason;
		case "unverified":
			return `The search did not establish a specific discrepancy: ${result.reason}`;
		case "needs-manual-review":
			return `The extension could not assess the discrepancy: ${result.reason}`;
	}
}

function extractUrls(text: string): string[] {
	const urls = text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
	return unique(urls.map((url) => url.replace(/[.,;:]+$/g, "")));
}

function summarizeReason(text: string, raw: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^https?:\/\//.test(line));
	const first = lines.find((line) => !/^[-*]?\s*(verdict|confidence|evidence urls?)\s*:/i.test(line));
	return first?.slice(0, 500) ?? `Search returned output but no clear verdict for: ${raw.slice(0, 160)}`;
}

function defaultConfidence(verdict: Verdict): number {
	switch (verdict) {
		case "valid":
			return 0.9;
		case "likely-valid":
			return 0.75;
		case "likely-hallucinated":
			return 0.82;
		case "unverified":
			return 0.55;
		case "needs-manual-review":
			return 0.4;
	}
}
