export type ConversionMode = "vlm" | "standard" | "dual";

export type Verdict =
	| "valid"
	| "likely-valid"
	| "unverified"
	| "likely-hallucinated"
	| "needs-manual-review";

export interface CitecheckOptions {
	input: string;
	recursive: boolean;
	outDir?: string;
	conversion: ConversionMode;
	fromMd: boolean;
	refsPage?: number;
	maxConcurrency: number;
	maxRefs?: number;
	yes: boolean;
	searchTimeoutMs: number;
	doclingTimeoutMs: number;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
}

export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface CommandInfo {
	name: string;
	source?: string;
	sourceInfo?: {
		path?: string;
		baseDir?: string;
		source?: string;
		scope?: string;
		origin?: string;
	};
}

export interface UiBridge {
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
	confirm?: (title: string, message: string, options?: any) => Promise<boolean>;
	setStatus?: (key: string, value: string | undefined) => void;
}

export interface RunBridge {
	cwd: string;
	exec: ExecFn;
	signal?: AbortSignal;
	hasUI: boolean;
	ui?: UiBridge;
	progress?: (message: string, level?: "info" | "warning" | "error") => void;
	progressIntervalMs?: number;
	getCommands?: () => CommandInfo[];
}

export interface DiscoveredInput {
	path: string;
	kind: "pdf" | "md";
}

export interface ReferenceSection {
	found: boolean;
	heading?: string;
	startLine?: number;
	endLine?: number;
	markdown: string;
	warnings: string[];
}

export interface ReferenceEntry {
	index: number;
	label?: string;
	raw: string;
}

export interface NormalizedReference {
	title?: string;
	authors?: string;
	year?: string;
	doi?: string;
	url?: string;
	arxivId?: string;
	query: string;
}

export interface ConversionArtifact {
	mode: "vlm" | "standard";
	markdownPath: string;
	refsPath: string;
	section: ReferenceSection;
	references: ReferenceEntry[];
}

export interface ConversionComparison {
	primaryMode: "vlm" | "standard";
	primaryReason: string;
	notesByPrimaryIndex: Record<number, string[]>;
	summary: string[];
}

export interface SearchResult {
	stage: "primary" | "citation-recheck";
	query: string;
	resultText: string;
	exitCode: number;
}

export interface SearchEvidence {
	query: string;
	purpose: string;
	rawTextPath?: string;
	resultText: string;
	results?: SearchResult[];
	selectedResult?: SearchResult["stage"];
	exitCode?: number;
	error?: string;
}

export interface ReferenceCheck {
	entry: ReferenceEntry;
	normalized: NormalizedReference;
	conversionNotes: string[];
	evidence?: SearchEvidence;
	verdict: Verdict;
	confidence: number;
	reason: string;
	discrepancy: string;
	evidenceUrls: string[];
}

export interface RefsOnlyPdfResult {
	path?: string;
	startPage?: number;
	endPage?: number;
	source?: "detected" | "specified";
	method?: string;
	warnings: string[];
}

export interface PaperReport {
	inputPath: string;
	inputKind: "pdf" | "md";
	slug: string;
	outputDir: string;
	conversionMode: ConversionMode;
	refsOnlyPdf?: RefsOnlyPdfResult;
	artifacts: ConversionArtifact[];
	comparison?: ConversionComparison;
	checks: ReferenceCheck[];
	warnings: string[];
	errors: string[];
	startedAt: string;
	finishedAt: string;
}

export interface SkippedPaperReport {
	inputPath: string;
	slug: string;
	reportPath: string;
	reason: string;
}

export interface SummaryReport {
	startedAt: string;
	finishedAt: string;
	outDir: string;
	options: CitecheckOptions;
	papers: PaperReport[];
	skipped: SkippedPaperReport[];
	counts: Record<Verdict | "total", number>;
}
