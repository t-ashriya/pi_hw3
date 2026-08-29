import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { choosePrimary, compareConversions } from "../src/compare.ts";
import type { ConversionArtifact } from "../src/types.ts";

function artifact(
	mode: ConversionArtifact["mode"],
	count: number,
	sectionFound: boolean,
): ConversionArtifact {
	return {
		mode,
		markdownPath: `${mode}.md`,
		refsPath: `${mode}.refs.md`,
		section: {
			found: sectionFound,
			markdown: "",
			warnings: [],
		},
		references: Array.from({ length: count }, (_, index) => ({
			index: index + 1,
			raw: `[${index + 1}] Author, Distinct reference ${index + 1}, 2025.`,
		})),
	};
}

describe("conversion selection", () => {
	it("uses VLM when it found the bibliography heading and standard only recovered a tail subset", () => {
		const standard = artifact("standard", 14, false);
		const vlm = artifact("vlm", 29, true);

		assert.equal(choosePrimary([vlm, standard]), vlm);
		const comparison = compareConversions([vlm, standard]);
		assert.equal(comparison?.primaryMode, "vlm");
		assert.match(comparison?.primaryReason ?? "", /explicit references heading/);
	});

	it("uses VLM for a materially larger extraction when heading evidence is equal", () => {
		const standard = artifact("standard", 20, true);
		const vlm = artifact("vlm", 30, true);

		assert.equal(choosePrimary([vlm, standard]), vlm);
		assert.match(compareConversions([vlm, standard])?.primaryReason ?? "", /materially more references.*30 vs 20/);
	});

	it("retains standard when VLM has only a small count difference", () => {
		const standard = artifact("standard", 40, true);
		const vlm = artifact("vlm", 42, true);

		assert.equal(choosePrimary([vlm, standard]), standard);
	});

	it("does not trade a much larger standard fallback for a shorter VLM section based on the heading alone", () => {
		const standard = artifact("standard", 30, false);
		const vlm = artifact("vlm", 20, true);

		assert.equal(choosePrimary([vlm, standard]), standard);
	});

	it("retains the conversion with an explicit heading when VLM only has an unbounded tail fallback", () => {
		const standard = artifact("standard", 20, true);
		const vlm = artifact("vlm", 30, false);

		assert.equal(choosePrimary([vlm, standard]), standard);
	});
});
