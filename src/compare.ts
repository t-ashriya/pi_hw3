import type { ConversionArtifact, ConversionComparison } from "./types.ts";
import { tokenJaccard } from "./references.ts";

export function compareConversions(artifacts: ConversionArtifact[]): ConversionComparison | undefined {
	if (artifacts.length === 0) return undefined;
	const standard = artifacts.find((artifact) => artifact.mode === "standard");
	const vlm = artifacts.find((artifact) => artifact.mode === "vlm");
	const primary = choosePrimary(artifacts);
	const other = primary.mode === "standard" ? vlm : standard;
	const notesByPrimaryIndex: Record<number, string[]> = {};
	const summary: string[] = [];

	if (standard && vlm) {
		if (standard.references.length !== vlm.references.length) {
			summary.push(
				`Reference count differs between conversion modes: standard=${standard.references.length}, vlm=${vlm.references.length}.`,
			);
		}
		if (!standard.section.found) summary.push("Standard conversion did not find an explicit references heading.");
		if (!vlm.section.found) summary.push("VLM conversion did not find an explicit references heading.");
	}

	if (other) {
		for (const reference of primary.references) {
			let best = 0;
			for (const candidate of other.references) {
				best = Math.max(best, tokenJaccard(reference.raw, candidate.raw));
			}
			const notes: string[] = [];
			if (best < 0.55) {
				notes.push(`No close match in ${other.mode} conversion (best token overlap ${best.toFixed(2)}).`);
			} else if (best < 0.8) {
				notes.push(`Partial match in ${other.mode} conversion (token overlap ${best.toFixed(2)}); inspect extraction quality.`);
			}
			if (notes.length > 0) notesByPrimaryIndex[reference.index] = notes;
		}
	} else {
		summary.push("Only one conversion artifact is available; no cross-conversion comparison was possible.");
	}

	return {
		primaryMode: primary.mode,
		primaryReason: primaryReason(primary, standard, vlm),
		notesByPrimaryIndex,
		summary,
	};
}

function primaryReason(
	primary: ConversionArtifact,
	standard: ConversionArtifact | undefined,
	vlm: ConversionArtifact | undefined,
): string {
	if (primary.mode === "standard") {
		return "Using standard Docling output as primary because its bibliography is at least as complete and is usually less distorted than VLM output.";
	}
	if (!standard || standard.references.length === 0) {
		return "Using VLM Docling output as primary because standard output had no references or was not requested.";
	}
	if (primary.section.found && !standard.section.found) {
		return "Using VLM Docling output as primary because it found an explicit references heading while standard used an incomplete best-effort tail section.";
	}
	if (vlm && hasMateriallyMoreReferences(vlm, standard)) {
		return `Using VLM Docling output as primary because it extracted materially more references than standard (${vlm.references.length} vs ${standard.references.length}).`;
	}
	return "Using VLM Docling output as primary because it provided the strongest available bibliography extraction.";
}

export function choosePrimary(artifacts: ConversionArtifact[]): ConversionArtifact {
	const standard = artifacts.find((artifact) => artifact.mode === "standard");
	const vlm = artifacts.find((artifact) => artifact.mode === "vlm");

	if (!standard || standard.references.length === 0) {
		return vlm?.references.length ? vlm : (standard ?? artifacts[0]!);
	}
	if (!vlm || vlm.references.length === 0) return standard;

	// A detected heading is stronger evidence that extraction started at the
	// beginning of the bibliography. The tail fallback can start halfway through
	// a numbered list, which previously made any non-empty standard result win
	// even when VLM had recovered the complete section.
	if (
		vlm.section.found &&
		!standard.section.found &&
		vlm.references.length >= standard.references.length
	) return vlm;
	if (standard.section.found && !vlm.section.found) return standard;

	// When heading evidence is equal, only let VLM's count override the usual
	// standard preference if the gain is large enough not to be a one-entry
	// splitting difference.
	if (hasMateriallyMoreReferences(vlm, standard)) return vlm;
	return standard;
}

function hasMateriallyMoreReferences(candidate: ConversionArtifact, baseline: ConversionArtifact): boolean {
	const candidateCount = candidate.references.length;
	const baselineCount = baseline.references.length;
	return candidateCount - baselineCount >= 3 && candidateCount >= baselineCount * 1.25;
}
