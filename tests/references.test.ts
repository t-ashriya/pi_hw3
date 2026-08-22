import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReferenceSection, splitReferences, tokenJaccard } from "../src/references.ts";
import { normalizeReference } from "../src/normalize.ts";
import { parseCitecheckArgs, tokenize, USAGE } from "../src/args.ts";
import { classifyEvidence } from "../src/verdict.ts";

describe("argument parsing", () => {
	it("defaults to dual conversion", () => {
		const parsed = parseCitecheckArgs("paper.pdf");
		assert.equal(parsed.ok, true);
		assert.equal(parsed.options?.conversion, "dual");
	});

	it("parses a known references page", () => {
		const parsed = parseCitecheckArgs("paper.pdf --refs-page 10");
		assert.equal(parsed.ok, true);
		assert.equal(parsed.options?.refsPage, 10);
	});

	it("documents command controls in help", () => {
		assert.match(USAGE, /stop\s+Stop the active \/citecheck run and terminate launched process trees\./);
		assert.match(USAGE, /--refs-page <n>\s+For PDFs, extract exactly page n \(1-based\) as the references page\./);
		assert.match(USAGE, /--references-page <n>\s+Alias for --refs-page\./);
	});

	it("tokenizes quoted paths", () => {
		assert.deepEqual(tokenize('"my paper.pdf" --out "reports here"'), ["my paper.pdf", "--out", "reports here"]);
	});
});

describe("reference extraction", () => {
	it("extracts only the references section", async () => {
		const md = await readFile(join(import.meta.dirname, "fixtures", "sample.md"), "utf8");
		const section = extractReferenceSection(md);
		assert.equal(section.found, true);
		assert.match(section.markdown, /ImageNet Classification/);
		assert.doesNotMatch(section.markdown, /Not references/);
	});

	it("splits numbered references", async () => {
		const md = await readFile(join(import.meta.dirname, "fixtures", "sample.md"), "utf8");
		const refs = splitReferences(extractReferenceSection(md).markdown);
		assert.equal(refs.length, 3);
		assert.match(refs[0]!.raw, /ImageNet Classification/);
		assert.match(refs[1]!.raw, /Deep residual learning/i);
	});

	it("normalizes useful search fields", async () => {
		const md = await readFile(join(import.meta.dirname, "fixtures", "sample.md"), "utf8");
		const ref = splitReferences(extractReferenceSection(md).markdown)[0]!;
		const normalized = normalizeReference(ref);
		assert.equal(normalized.year, "2012");
		assert.equal(normalized.title, "ImageNet Classification with Deep Convolutional Neural Networks");
		assert.match(normalized.query, /ImageNet Classification/);
	});

	it("extracts single-quoted titles without absorbing et al author text", () => {
		const ref = {
			index: 13,
			raw: "[13] Z. Li, S. Le, J. Chen, et al., 'Decomposed and Distributed Modulation to Achieve Secure Transmission,' IEEE Trans. Mobile Comput., vol. 23, no. 12, pp. 11172-11190, 2024.",
		};
		const normalized = normalizeReference(ref);
		assert.equal(normalized.title, "Decomposed and Distributed Modulation to Achieve Secure Transmission");
		assert.equal(normalized.authors, "Z. Li, S. Le, J. Chen, et al");
		assert.equal(
			normalized.query,
			'Official publication record for "Decomposed and Distributed Modulation to Achieve Secure Transmission" Z. Li 2024. Claimed citation: [13] Z. Li, S. Le, J. Chen, et al., \'Decomposed and Distributed Modulation to Achieve Secure Transmission,\' IEEE Trans. Mobile Comput., vol. 23, no. 12, pp. 11172-11190, 2024.',
		);
	});

	it("keeps the claimed title, authors, and venue in DOI searches", () => {
		const normalized = normalizeReference({
			index: 4,
			raw: "[4] A. Author, 'Claimed Paper,' Claimed Venue, 2024, doi:10.1000/example.",
		});
		assert.match(normalized.query, /DOI 10\.1000\/example/);
		assert.match(normalized.query, /A\. Author/);
		assert.match(normalized.query, /Claimed Paper/);
		assert.match(normalized.query, /Claimed Venue/);
	});

	it("maps an obsolete mismatch verdict with a failed title or venue match to likely-hallucinated", () => {
		const ref = {
			index: 17,
			raw: "[17] Z. Li, C. Liu, L. Zhang, et al., 'Exploiting Interference With an Intelligent Reflecting Surface to Enhance Data Transmission,' IEEE Trans. Wireless Commun., vol. 23, no. 8, pp. 9776-9792, 2024.",
		};
		const result = classifyEvidence(ref, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: mismatch\nConfidence: 0.98\nReason: The cited paper is real, but the extracted reference misstates the title/venue details and truncates the author list; the authentic record is 2024 in IEEE Transactions on Wireless Communications with DOI 10.1109/TWC.2024.3366229.\nEvidence URLs: https://doi.org/10.1109/TWC.2024.3366229",
		});
		assert.equal(result.verdict, "likely-hallucinated");
	});

	it("keeps a real paper likely-valid when only its metadata is wrong", () => {
		const result = classifyEvidence({ index: 7, raw: "[7] A. Author, 'Real Paper,' Journal, 2016." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: mismatch\nConfidence: 0.91\nReason: The cited paper is real, but the reference has a year mismatch: the original reference lists 2016 while the canonical record shows 2017.\nEvidence URLs: https://doi.org/10.0000/example",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("overrides a negative verdict when the same paper differs only in year and pages", () => {
		const result = classifyEvidence({
			index: 19,
			raw: "[20] L. Xing, B. Li, K. Deng et al., 'Nereus: Network resource prediction-based digital twin dynamic placement in traffic systems,' IEEE Trans. Veh. Technol., pp. 1-16, 2025.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-hallucinated\nConfidence: 0.93\nReason: Primary records identify the same paper title, author set, and IEEE Transactions on Vehicular Technology venue; the main issue is secondary metadata because the journal record has a 2026 year and a different page range rather than the cited 2025 and pp. 1-16.\nEvidence URLs: https://doi.org/10.1109/TVT.2025.3642247",
		});
		assert.equal(result.verdict, "likely-valid");
		assert.match(result.reason, /minor secondary metadata/);
	});

	it("classifies each batch-02 false positive as likely-valid", () => {
		const cases = [
			{
				name: "Centroid-Guided Target-Driven Topology Control",
				entry: {
					index: 4,
					raw: "[4] J. Li, P. Yi, T. Duan, Y. Wang, Z. Zhang, J. Yu, and T. Hu, 'Centroidguided target-driven topology control method for UAV Ad-hoc networks based on tiny deep reinforcement learning algorithm,' IEEE Internet Thing J., vol. 9, no. 3, pp. 20-29, 2024.",
				},
				resultText: "Verdict: likely-valid\nConfidence: 0.95\nReason: Primary and corroborating bibliographic sources identify the same paper title and author set, but the reference’s venue/volume/pages are inconsistent with the official IEEE metadata and appear to be secondary-field errors rather than a wrong work.\nEvidence URLs: https://doi.org/10.1109/JIOT.2024.3376647",
			},
			{
				name: "Detection and Tracking Meet Drones Challenge",
				entry: {
					index: 9,
					raw: "[9] P. Zhu, L. Wen, D. Du, X. Bian, H. Fan, Q. Hu, and H. Ling, 'Detection and tracking meet drones challenge,' IEEE Trans. Pattern Anal. Mach. Intell., vol. 44, no. 11, pp. 7380-7399, 2021.",
				},
				resultText: "Verdict: valid\nConfidence: 0.96\nReason: Crossref/IEEE-indexed metadata and corroborating bibliographic sources agree on the same paper, authors, TPAMI venue, volume 44 issue 11, and pages 7380–7399; the 2021 date in the citation is a minor timing difference for a 2022 journal issue, not a different work.\nEvidence URLs: https://doi.org/10.1109/tpami.2021.3119563",
			},
			{
				name: "VLsI",
				entry: {
					index: 20,
					raw: "[20] B.-K. Lee, R. Hachiuma, Y.-C. F. Wang et al., 'VLsI: Verbalized layersto-interactions from large to small vision language models,' in Proc. CVPR, Jun. 2025, pp. 29 545-29 557.",
				},
				resultText: "Verdict: likely-valid\nConfidence: 0.96\nReason: Primary sources confirm the exact title and a matching CVPR 2025 publication record; the cited ‘et al.’ and page span are minor metadata issues, while one author-name field is a transliteration variant rather than a core identity conflict.\nEvidence URLs: https://dblp.org/rec/conf/cvpr/LeeHWRW25.html",
			},
		];

		for (const testCase of cases) {
			const result = classifyEvidence(testCase.entry, {
				query: "",
				purpose: "",
				resultText: testCase.resultText,
			});
			assert.equal(result.verdict, "likely-valid", testCase.name);
			assert.match(result.discrepancy, /secondary|timing|metadata/i, testCase.name);
		}
	});

	it("treats an omitted venue and a one-year preprint difference as likely-valid", () => {
		const result = classifyEvidence({
			index: 20,
			raw: "[21] X. Guo and Z. Lyu, 'Policy transfer ensures fast learning for continuous-time LQR with entropy regularization,' 2026.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: valid\nConfidence: 0.97\nReason: Primary sources (OpenReview and arXiv) identify the exact title and authors, and the 2026 year aligns with the ICLR 2026 venue context rather than the 2025 arXiv posting date.\nEvidence URLs: https://openreview.net/forum?id=7UPZMoLRTI https://arxiv.org/abs/2510.15165",
		});
		assert.equal(result.verdict, "likely-valid");
		assert.match(result.reason, /venue was omitted/);
	});

	it("promotes an exact publisher DOI match to valid despite an earlier preprint", () => {
		const result = classifyEvidence({
			index: 15,
			raw: "[15] S. Zhang et al., 'Instruction tuning for large language models: A survey,' ACM Comput. Surv., vol. 58, no. 7, pp. 1-36, 2026.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.98\nReason: The ACM DOI landing page confirms the exact title, author list, venue, volume/issue, pages, and a 2026 publication date; the 2023 arXiv entry is only an earlier preprint.\nEvidence URLs: https://doi.org/10.1145/3777411 https://arxiv.org/abs/2308.10792",
		});
		assert.equal(result.verdict, "valid");
	});

	it("does not mistake a year embedded in a DOI for the formal publication year", () => {
		const result = classifyEvidence({
			index: 19,
			raw: "[19] A. Author, 'A real paper,' IEEE Journal, 2025.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.94\nReason: DOI 10.1109/TEST.2025.1234567 confirms the exact title, author list, and venue, but the formal publication date is 2026; the only issue is the cited year.\nEvidence URLs: https://doi.org/10.1109/TEST.2025.1234567",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("classifies one material venue mismatch as likely-hallucinated", () => {
		const result = classifyEvidence({
			index: 3,
			raw: "[3] E. Kim, I. P. Roberts, and J. G. Andrews, 'Downlink analysis and evaluation of multi-beam leo satellite communication in shadowed rician channels,' IEEE Transactions on Wireless Communications, 2024.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.97\nReason: The title, authors, and year match, but the cited venue is wrong: the official record is IEEE Transactions on Vehicular Technology rather than IEEE Transactions on Wireless Communications.\nEvidence URLs: https://dblp.org/rec/journals/tvt/KimRA24",
		});
		assert.equal(result.verdict, "likely-hallucinated");
		assert.match(result.reason, /venue is wrong/);
	});

	it("treats a confirmed arXiv citation as valid when the same work later appeared at NDSS", () => {
		const result = classifyEvidence({
			index: 21,
			raw: "[21] Z. Liu, N. Samwel, L. Weissbart, Z. Zhao, D. Lauret, L. Batina, and M. Larson, 'Screen gleaning: A screen reading tempest attack on mobile devices exploiting an electromagnetic side channel,' arXiv preprint arXiv:2011.09877, 2020.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.98\nReason: Primary NDSS sources match the title and author list exactly and place the work in NDSS Symposium 2021, so the arXiv/2020 citation is a benign venue-year mismatch rather than a material error.\nEvidence URLs: https://www.ndss-symposium.org/ndss-paper/screen-gleaning/ https://arxiv.org/abs/2011.09877",
		});
		assert.equal(result.verdict, "valid");
		assert.match(result.reason, /arXiv identifier 2011\.09877 resolves to the same work/);
	});

	it("keeps an arXiv-versus-conference version issue likely-valid when the identifier is not confirmed", () => {
		const result = classifyEvidence({
			index: 8,
			raw: "[8] A. Author and B. Author, 'A Real Paper,' arXiv preprint arXiv:2301.12345, 2023.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-hallucinated\nConfidence: 0.91\nReason: The same title and authors match a real conference paper, but the cited arXiv number could not be confirmed and the official publication is at ExampleConf 2024.\nEvidence URLs: https://example.org/conference/paper",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("keeps a real product page likely-valid despite minor URL and page-title questions", () => {
		const result = classifyEvidence({
			index: 2,
			raw: "[2] Sony, 'Sony playstation,' 2025. [Online]. Available: https://direct. playstation.com/en-us/buy-consoles/playstationvr2",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-hallucinated\nConfidence: 0.92\nReason: The official PlayStation page exists, but the page identity is PlayStation VR2 rather than the broad title Sony PlayStation.\nEvidence URLs: https://direct.playstation.com/en-us/buy-consoles/playstationvr2 https://www.playstation.com/en-us/ps-vr2/",
		});
		assert.equal(result.verdict, "likely-valid");
		assert.match(result.reason, /online resource exists/);
	});

	it("keeps a nearby official catalog URL likely-valid", () => {
		const result = classifyEvidence({
			index: 30,
			raw: "[30] E. Research, 'USRP N210,' 2025. [Online]. Available: https://www.ettus.com/all-products/",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-hallucinated\nConfidence: 0.94\nReason: Primary Ettus sources show USRP N210 as a hardware product and catalog item rather than a formal publication.\nEvidence URLs: https://kb.ettus.com/N200/N210 https://www.ettus.com/all-products/",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("does not rescue an online citation whose target is explicitly unrelated", () => {
		const result = classifyEvidence({
			index: 3,
			raw: "[3] Example, 'Antenna manual,' 2025. [Online]. Available: https://example.com/camera",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-hallucinated\nConfidence: 0.96\nReason: The cited URL is a real official product page, but it points to an unrelated camera rather than the quoted antenna resource.\nEvidence URLs: https://example.com/camera",
		});
		assert.equal(result.verdict, "likely-hallucinated");
	});

	it("does not treat initials and hyphenation variants as citation mismatches", () => {
		const result = classifyEvidence({
			index: 41,
			raw: "[41] B. Wang, F. Zhu, W. Li, Z. Yang, M. Jin, and X. Tian, 'Frequencyagile ofdm backscatter,' in Proceedings of the 22nd Annual International Conference on Mobile Systems, Applications and Services, p. 252-264, ACM New York, NY, USA, 2024.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.97\nReason: The title, author identities, and MobiSys 2024 venue match; the differences are only initials, et al., hyphenation, and abbreviated formatting.\nEvidence URLs: https://doi.org/10.1145/3643832.3661873",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("keeps a structured valid verdict when verbose evidence only discusses avoiding a mismatch", () => {
		const result = classifyEvidence({
			index: 3,
			raw: "[3] M. Luo, X. Shi, C. Cai et al., 'Agentix: An efficient serving engine for LLM agents as general programs,' in NSDI 26, 2026, pp. 2443-2459.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: valid\nConfidence: 0.99\nReason: The reference matches an actual USENIX NSDI 2026 paper with the same title, author set, venue, year, pages, and official URL; M. Luo is a valid abbreviation for Michael Luo.\nEvidence URLs: https://www.usenix.org/conference/nsdi26/presentation/luo\n\nKey finding: The venue and date align. This avoids a venue mismatch, which would have been a red flag.",
		});
		assert.equal(result.verdict, "valid");
		assert.equal(result.confidence, 0.99);
	});

	it("does not turn negated or hypothetical mismatch discussion into a mismatch", () => {
		const result = classifyEvidence({ index: 18, raw: "[18] A valid INFOCOM paper." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: valid\nConfidence: 0.96\nReason: The title, year, author set, venue, and page range all match a real paper record.\nEvidence URLs: https://example.com/paper\n\nNo disagreement was found; nothing suggests a wrong journal or conference venue.",
		});
		assert.equal(result.verdict, "valid");
	});

	it("rescues a negative verdict when the reason negates an identity conflict", () => {
		const result = classifyEvidence({ index: 19, raw: "[19] A. Author, 'A real paper,' Journal, pp. 1-10, 2025." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-hallucinated\nConfidence: 0.95\nReason: Sources confirm the same paper, title, authors, and venue; the authors are not wrong and the page difference is a minor metadata issue, so this is not likely-hallucinated.\nEvidence URLs: https://example.com/paper",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("does not treat benign formatting differences in a positive reason as material", () => {
		const result = classifyEvidence({ index: 34, raw: "[34] A real journal paper." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.98\nReason: The reference matches the same title, volume, issue, pages, and DOI; only the abbreviated author/venue formatting differs.\nEvidence URLs: https://example.com/paper",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("classifies a reported AutoGen venue mismatch as likely-hallucinated", () => {
		const result = classifyEvidence({
			index: 1,
			raw: "[1] Q. Wu, G. Bansal, J. Zhang et al., 'AutoGen: Enabling next-gen LLM applications via multi-agent conversations,' in COLM, 2024.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.95\nReason: The reference points to a real work by Qingyun Wu et al.; the title is essentially correct, but the original citation's venue is wrong.\nEvidence URLs: https://arxiv.org/abs/2308.08155",
		});
		assert.equal(result.verdict, "likely-hallucinated");
		assert.equal(result.confidence, 0.95);
	});

	it("classifies one material title mismatch as likely-hallucinated", () => {
		const result = classifyEvidence({ index: 8, raw: "[8] A. Author, 'Unconfirmed Title,' 2025." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: mismatch\nConfidence: 0.88\nReason: A real paper exists, but its verified title differs materially from the cited title.\nEvidence URLs: https://example.com/different-paper",
		});
		assert.equal(result.verdict, "likely-hallucinated");
	});

	it("classifies one material author mismatch as likely-hallucinated", () => {
		const result = classifyEvidence({ index: 9, raw: "[9] A. Author, 'Confirmed Title,' Correct Venue, 2025." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: valid\nConfidence: 0.93\nReason: The title and venue match the official record, but the cited authors do not match its actual author list.\nEvidence URLs: https://example.com/official-record",
		});
		assert.equal(result.verdict, "likely-hallucinated");
		assert.equal(result.confidence, 0.93);
	});

	it("reports strong fabrication evidence as likely-hallucinated", () => {
		const result = classifyEvidence({ index: 9, raw: "[9] A. Fake, 'Invented Work,' 2025." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-hallucinated\nConfidence: 0.91\nReason: The cited title appears fabricated and no corresponding publication exists.\nEvidence URLs:",
		});
		assert.equal(result.verdict, "likely-hallucinated");
	});

	it("computes fuzzy overlap for conversion comparison", () => {
		const a = "[1] A. Author, Interesting Systems Paper, IEEE INFOCOM, 2024.";
		const b = "1. A. Author. Interesting Systems Paper. Proc. IEEE INFOCOM, 2024.";
		assert.ok(tokenJaccard(a, b) > 0.55);
	});
});
