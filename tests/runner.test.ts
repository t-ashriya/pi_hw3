import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCitecheck } from "../src/runner.ts";
import type { ExecFn } from "../src/types.ts";

describe("runner", () => {
	it("checks an existing Markdown file and writes reports", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const progressMessages: string[] = [];
		const exec: ExecFn = async (command) => {
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "node") {
				return {
					stdout: JSON.stringify({
						result:
							"Verdict: likely-valid\nConfidence: 0.81\nReason: title and year match a real paper.\nDiscrepancy: title formatting: cited capitalization -> publisher capitalization\nEvidence URLs: https://example.com/paper",
					}),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		const fixture = join(import.meta.dirname, "fixtures", "sample.md");
		await runCitecheck(`${fixture} --from-md --out ${join(temp, "out")} --max-refs 1 --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			progress: (message) => progressMessages.push(message),
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		const summaryMarkdown = await readFile(join(temp, "out", "summary.md"), "utf8");
		assert.equal(existsSync(join(temp, "out", "summary.json")), false);
		assert.doesNotMatch(summaryMarkdown, /## Verdict counts/);
		assert.doesNotMatch(summaryMarkdown, /## Paper attention counts/);
		assert.doesNotMatch(summaryMarkdown, /## Per-paper verdict counts/);
		assert.match(summaryMarkdown, /## Papers that need attention\n\n_No papers need attention\._/);
		assert.match(summaryMarkdown, /## Citation checks on all papers/);
		assert.match(summaryMarkdown, /\| Paper \| Total references \| valid \| likely-valid \| likely-hallucinated \| unverified \| needs-manual-review \|/);
		assert.match(summaryMarkdown, /\| sample\.md \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \|/);
		assert.ok(progressMessages.some((message) => message.includes("/citecheck processing 1 Markdown file")));
		assert.ok(progressMessages.some((message) => message.includes("/citecheck web-search started: sample")));
		assert.ok(progressMessages.some((message) => message.includes("/citecheck web-search 1/1: sample")));
		assert.ok(progressMessages.some((message) => message.includes("/citecheck complete:")));

		assert.equal(existsSync(join(temp, "out", "reports", "sample.report.json")), false);
		assert.equal(existsSync(join(temp, "out", "raw-search", "sample", "ref-001.json")), false);
		const paperMarkdown = await readFile(join(temp, "out", "reports", "sample.report.md"), "utf8");
		assert.match(paperMarkdown, /### Reference 1: likely-valid/);
		assert.match(paperMarkdown, /ImageNet Classification/);
		assert.match(paperMarkdown, /Discrepancy: title formatting: cited capitalization -> publisher capitalization/);
		assert.match(paperMarkdown, /#### Primary web search result \(used for classification\)/);
		assert.match(paperMarkdown, /> Verdict: likely-valid/);
		assert.doesNotMatch(paperMarkdown, /raw JSON:/);
	});

	it("rechecks a claimed citation mismatch against the exact citation", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");
		const input = join(temp, "autogen.md");
		await writeFile(
			input,
			"# Paper\n\n## References\n\n[1] Q. Wu, G. Bansal, J. Zhang et al., 'AutoGen: Enabling next-gen LLM applications via multi-agent conversations,' in Conference on Language Modeling (COLM), 2024.\n",
			"utf8",
		);

		let searchCalls = 0;
		const queries: string[] = [];
		const purposes: string[] = [];
		const exec: ExecFn = async (command, args) => {
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "node") {
				searchCalls++;
				queries.push(args[1] ?? "");
				const purposeIndex = args.indexOf("--purpose");
				purposes.push(purposeIndex >= 0 ? args[purposeIndex + 1] ?? "" : "");
				const result = searchCalls === 1
					? "Verdict: likely-valid\nConfidence: 0.95\nReason: The work is real, but the original citation's venue is wrong because it was a workshop paper.\nDiscrepancy: venue: COLM -> workshop\nEvidence URLs: https://example.com/workshop"
					: "Verdict: valid\nConfidence: 0.99\nReason: The official COLM 2024 accepted-papers page confirms this publication and author list.\nDiscrepancy: none\nEvidence URLs: https://colmweb.org/2024/AcceptedPapers.html";
				return { stdout: JSON.stringify({ result }), stderr: "", code: 0 };
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		const outDir = join(temp, "out");
		await runCitecheck(`${input} --from-md --out ${outDir} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			getCommands: () => [{
				name: "native-web-search",
				source: "skill",
				sourceInfo: { path: join(skillDir, "SKILL.md") },
			}],
		});

		assert.equal(searchCalls, 2);
		assert.match(queries[0]!, /COLM/);
		assert.match(queries[1]!, /COLM/);
		assert.match(purposes[1]!, /official venue website/);
		assert.match(purposes[0]!, /title OR authors OR venue/);
		assert.match(purposes[1]!, /title OR authors OR venue/);
		assert.match(purposes[0]!, /Online-resource rule/);
		assert.match(purposes[0]!, /arXiv-version rule/);
		assert.match(purposes[1]!, /Online-resource rule/);
		assert.match(purposes[1]!, /arXiv-version rule/);
		const report = await readFile(join(outDir, "reports", "autogen.report.md"), "utf8");
		assert.match(report, /### Reference 1: valid/);
		assert.match(report, /official COLM 2024 accepted-papers page confirms/);
		assert.match(report, /#### Primary web search result/);
		assert.match(report, /#### Citation recheck result \(used for classification\)/);
		assert.match(report, /> Discrepancy: venue: COLM -> workshop/);
		assert.match(report, /> Discrepancy: none/);
		const raw = await readFile(join(outDir, "raw-search", "autogen", "ref-001.stdout.txt"), "utf8");
		assert.match(raw, /\[primary search\]/);
		assert.match(raw, /\[citation recheck\]/);
	});

	it("rechecks a likely-hallucinated result using a DOI discovered by the first search", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");
		const input = join(temp, "instruction-tuning.md");
		await writeFile(
			input,
			"# Paper\n\n## References\n\n[15] S. Zhang, L. Dong, X. Li et al., 'Instruction tuning for large language models: A survey,' ACM Comput. Surv., vol. 58, no. 7, pp. 1-36, 2026.\n",
			"utf8",
		);

		let searchCalls = 0;
		const queries: string[] = [];
		const purposes: string[] = [];
		const exec: ExecFn = async (command, args) => {
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "node") {
				searchCalls++;
				queries.push(args[1] ?? "");
				const purposeIndex = args.indexOf("--purpose");
				purposes.push(purposeIndex >= 0 ? args[purposeIndex + 1] ?? "" : "");
				const result = searchCalls === 1
					? "Verdict: likely-hallucinated\nConfidence: 0.96\nReason: The work exists, but the claimed ACM publication does not match the older arXiv record.\nEvidence URLs: https://arxiv.org/abs/2308.10792 https://doi.org/10.1145/3777411"
					: "Verdict: valid\nConfidence: 0.99\nReason: The ACM and Crossref records confirm the title, authors, ACM Computing Surveys volume 58 issue 7, pages 1-36, and 2026 publication year.\nEvidence URLs: https://dl.acm.org/doi/10.1145/3777411 https://doi.org/10.1145/3777411";
				return { stdout: JSON.stringify({ result }), stderr: "", code: 0 };
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		const outDir = join(temp, "out");
		await runCitecheck(`${input} --from-md --out ${outDir} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			getCommands: () => [{
				name: "native-web-search",
				source: "skill",
				sourceInfo: { path: join(skillDir, "SKILL.md") },
			}],
		});

		assert.equal(searchCalls, 2);
		assert.match(queries[1]!, /https:\/\/doi\.org\/10\.1145\/3777411/);
		assert.match(purposes[1]!, /Resolve every DOI and inspect its publisher or Crossref metadata/);
		assert.match(purposes[1]!, /10\.1145\/3777411/);
		const report = await readFile(join(outDir, "reports", "instruction-tuning.report.md"), "utf8");
		assert.match(report, /### Reference 1: valid/);
		assert.match(report, /ACM and Crossref records confirm/);
	});

	it("summary attention section lists only papers with hallucinated, unverified, or manual-review counts", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const papersDir = join(temp, "papers");
		await mkdir(papersDir, { recursive: true });
		await writeFile(join(papersDir, "hallucinated.md"), "# Hallucinated\n\n## References\n\n[1] C. Author, 'Invented Paper,' Conf, 2022.\n", "utf8");
		await writeFile(join(papersDir, "needs.md"), "# Needs\n\n## References\n\n[1] A. Author, 'Needs Attention,' Conf, 2020.\n", "utf8");
		await writeFile(join(papersDir, "ok.md"), "# OK\n\n## References\n\n[1] B. Author, 'Looks Good,' Conf, 2021.\n", "utf8");

		const exec: ExecFn = async (command, args) => {
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "node") {
				const query = args[1] ?? "";
				const verdict = query.includes("Needs Attention")
					? "needs-manual-review"
					: query.includes("Invented Paper")
						? "likely-hallucinated"
						: "valid";
				return {
					stdout: JSON.stringify({
						result: `Verdict: ${verdict}\nConfidence: 0.90\nReason: test evidence.\nEvidence URLs: https://example.com/paper`,
					}),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		await runCitecheck(`${papersDir} --from-md --out ${join(temp, "out")} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		const summaryMarkdown = await readFile(join(temp, "out", "summary.md"), "utf8");
		const attentionSection = /## Papers that need attention\n\n([\s\S]*?)\n\n## Citation checks on all papers/.exec(summaryMarkdown)?.[1] ?? "";
		assert.match(attentionSection, /\| Paper \| likely-hallucinated \| unverified \| needs-manual-review \|/);
		assert.match(attentionSection, /\| hallucinated\.md \| 1 \| 0 \| 0 \|/);
		assert.match(attentionSection, /\| needs\.md \| 0 \| 0 \| 1 \|/);
		assert.doesNotMatch(attentionSection, /ok\.md/);
		assert.match(summaryMarkdown, /\| hallucinated\.md \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \|/);
		assert.match(summaryMarkdown, /\| ok\.md \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
	});

	it("skips papers with existing reports when --out is reused", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const papersDir = join(temp, "papers");
		await mkdir(papersDir, { recursive: true });
		await writeFile(join(papersDir, "already.md"), "# A\n\n## References\n\n[1] A. Author, 'Already Done,' Conf, 2020.\n", "utf8");
		await writeFile(join(papersDir, "remaining.md"), "# B\n\n## References\n\n[1] B. Author, 'Remaining Paper,' Conf, 2021.\n", "utf8");

		const outDir = join(temp, "out");
		await mkdir(join(outDir, "reports"), { recursive: true });
		await writeFile(join(outDir, "reports", "already.report.md"), "# existing report\n", "utf8");

		let searchCalls = 0;
		const progressMessages: string[] = [];
		const exec: ExecFn = async (command) => {
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "node") {
				searchCalls++;
				return {
					stdout: JSON.stringify({
						result:
							"Verdict: valid\nConfidence: 0.90\nReason: title and year match a real paper.\nEvidence URLs: https://example.com/paper",
					}),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		await runCitecheck(`${papersDir} --from-md --out ${outDir} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			progress: (message) => progressMessages.push(message),
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		assert.equal(searchCalls, 1);
		assert.ok(progressMessages.some((message) => message.includes("already skipped")));
		assert.ok(progressMessages.some((message) => message.includes("1 skipped")));
		assert.equal(existsSync(join(outDir, "reports", "remaining.report.md")), true);
		const summaryMarkdown = await readFile(join(outDir, "summary.md"), "utf8");
		assert.match(summaryMarkdown, /## Skipped existing reports/);
		assert.match(summaryMarkdown, /already\.md/);
		assert.match(summaryMarkdown, /reports\/already\.report\.md/);
	});

	it("uses a specified references page as a single-page PDF slice", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const pdf = join(temp, "paper.pdf");
		await writeFile(pdf, "%PDF fake\n", "utf8");

		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: ExecFn = async (command, args) => {
			calls.push({ command, args });
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "qpdf") return { stdout: "", stderr: "", code: 0 };
			if (command === "docling") {
				const outIndex = args.indexOf("--output");
				assert.notEqual(outIndex, -1);
				const outDir = args[outIndex + 1]!;
				await mkdir(outDir, { recursive: true });
				await writeFile(
					join(outDir, "converted.md"),
					"# Converted\n\n## References\n\n[1] A. Author, 'Known Paper,' Journal, 2020.\n",
					"utf8",
				);
				return { stdout: "", stderr: "", code: 0 };
			}
			if (command === "node") {
				return {
					stdout: JSON.stringify({
						result:
							"Verdict: valid\nConfidence: 0.90\nReason: title and year match a real paper.\nEvidence URLs: https://example.com/paper",
					}),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		await runCitecheck(`${pdf} --refs-page 10 --conversion standard --out ${join(temp, "out")} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		assert.equal(calls.some((call) => call.command === "pdftotext"), false);
		const qpdf = calls.find((call) => call.command === "qpdf");
		assert.ok(qpdf);
		assert.deepEqual(qpdf.args.slice(0, 5), ["--empty", "--pages", pdf, "10", "--"]);

		const docling = calls.find((call) => call.command === "docling");
		assert.equal(docling?.args.at(-1), qpdf.args[5]);
		assert.equal(docling?.args.includes(pdf), false);

		assert.equal(existsSync(join(temp, "out", "reports", "paper.report.json")), false);
		const paperMarkdown = await readFile(join(temp, "out", "reports", "paper.report.md"), "utf8");
		assert.match(paperMarkdown, /specified references page 10/);
		assert.match(paperMarkdown, /method qpdf/);
		assert.match(paperMarkdown, /### Reference 1: valid/);
	});

	it("does not fall back to full-PDF Docling when a specified references page cannot be sliced", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const pdf = join(temp, "paper.pdf");
		await writeFile(pdf, "%PDF fake\n", "utf8");

		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: ExecFn = async (command, args) => {
			calls.push({ command, args });
			if (command === "sh") {
				const script = args[1] ?? "";
				if (script.includes("qpdf") || script.includes("python3")) {
					return { stdout: "", stderr: "", code: 1 };
				}
				return { stdout: "", stderr: "", code: 0 };
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		await runCitecheck(`${pdf} --refs-page 10 --conversion standard --out ${join(temp, "out")} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		assert.equal(calls.some((call) => call.command === "docling"), false);
		assert.equal(existsSync(join(temp, "out", "reports", "paper.report.json")), false);
		const paperMarkdown = await readFile(join(temp, "out", "reports", "paper.report.md"), "utf8");
		assert.match(paperMarkdown, /## Errors/);
		assert.match(paperMarkdown, /refusing to convert the full PDF/);
	});
});
