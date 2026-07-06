import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, extname, join } from "node:path";
import type { TriageReviewPacket } from "../governance/types.js";
import type { ProviderConfig } from "../config/schema.js";
import { loadConfig } from "../config/index.js";

// ---------------------------------------------------------------------------
// Shared document metadata shape used internally by triage
// ---------------------------------------------------------------------------

export interface DocMeta {
  path: string;
  tags: string[];
  type: string;
  clusterMembership: string[];
  relatedNotes: string[];
  filenamePrefixes: string[];
}

export interface Cluster {
  candidates: DocMeta[];
  canonicals: DocMeta[];
}

export type ClusterMap = Record<string, Cluster>;

// ---------------------------------------------------------------------------
// clusterCandidates
// ---------------------------------------------------------------------------

/**
 * Groups candidate docs into named clusters using metadata overlap with canonicals.
 * Candidates with no signal match go into the "general" bucket.
 */
export function clusterCandidates(candidates: DocMeta[], canonicals: DocMeta[]): ClusterMap {
  const clusters: ClusterMap = {};

  // Build cluster names from canonicals
  for (const canonical of canonicals) {
    const names = clusterNamesFor(canonical);
    for (const name of names) {
      if (!clusters[name]) {
        clusters[name] = { candidates: [], canonicals: [] };
      }
      if (!clusters[name].canonicals.includes(canonical)) {
        clusters[name].canonicals.push(canonical);
      }
    }
  }

  // Assign each candidate to its best cluster
  for (const candidate of candidates) {
    const candidateNames = clusterNamesFor(candidate);
    let assigned = false;

    for (const name of candidateNames) {
      if (clusters[name]) {
        clusters[name].candidates.push(candidate);
        assigned = true;
        break; // assign to first matching cluster only — multi-cluster candidates would inflate batch sizes
      }
    }

    if (!assigned) {
      if (!clusters["general"]) {
        clusters["general"] = { candidates: [], canonicals: [] };
      }
      clusters["general"].candidates.push(candidate);
    }
  }

  // Ensure general bucket exists
  if (!clusters["general"]) {
    clusters["general"] = { candidates: [], canonicals: [] };
  }

  return clusters;
}

function clusterNamesFor(doc: DocMeta): string[] {
  const names: string[] = [];

  // Tags take priority
  for (const tag of doc.tags) {
    if (tag.trim()) names.push(tag.toLowerCase().trim());
  }

  // Cluster membership
  for (const c of doc.clusterMembership) {
    if (c.trim()) names.push(c.toLowerCase().trim());
  }

  // Filename prefix (e.g. "ADR", "EVOlearn")
  for (const p of doc.filenamePrefixes) {
    if (p.trim()) names.push(p.toLowerCase().trim());
  }

  // Type as fallback
  if (doc.type.trim()) names.push(doc.type.toLowerCase().trim());

  return names;
}

// ---------------------------------------------------------------------------
// extractSymbols
// ---------------------------------------------------------------------------

const BACKTICK_RE = /`([A-Za-z_][A-Za-z0-9_]{3,})`/g;
const CAMEL_PASCAL_RE = /(?<![`\w])([A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z][a-z]+(?:[A-Z][a-z0-9]+)+)(?![`\w])/g;

/**
 * Extracts likely code symbol names from markdown text.
 * Returns deduplicated symbol names of 4+ characters.
 */
export function extractSymbols(text: string): string[] {
  const found = new Set<string>();

  let m: RegExpExecArray | null;

  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(text)) !== null) {
    found.add(m[1]);
  }

  CAMEL_PASCAL_RE.lastIndex = 0;
  while ((m = CAMEL_PASCAL_RE.exec(text)) !== null) {
    found.add(m[1]);
  }

  return Array.from(found);
}

// ---------------------------------------------------------------------------
// DocMeta loader
// ---------------------------------------------------------------------------

/**
 * Parses YAML frontmatter from a markdown file and returns DocMeta.
 * Does not throw — returns empty arrays on any parse failure.
 */
export function loadDocMeta(filePath: string): DocMeta {
  let content = "";
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return emptyMeta(filePath);
  }

  const frontmatter = parseFrontmatter(content);
  const filenamePrefixes = extractFilenamePrefixes(basename(filePath, extname(filePath)));

  return {
    path: filePath,
    tags: toStringArray(frontmatter["Tags"] ?? frontmatter["tags"]),
    type: String(frontmatter["Type"] ?? frontmatter["type"] ?? "").trim(),
    clusterMembership: toStringArray(frontmatter["Member Of Concept Cluster"]),
    relatedNotes: toStringArray(frontmatter["Related Notes"]),
    filenamePrefixes,
  };
}

/**
 * Reads all .md files from a directory and returns their DocMeta.
 */
export function loadAllDocMeta(dir: string): DocMeta[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return entries.map((f) => loadDocMeta(join(dir, f)));
}

function emptyMeta(filePath: string): DocMeta {
  return {
    path: filePath,
    tags: [],
    type: "",
    clusterMembership: [],
    relatedNotes: [],
    filenamePrefixes: extractFilenamePrefixes(basename(filePath, extname(filePath))),
  };
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  const listBuffer: string[] = [];

  const flushList = () => {
    if (currentKey && listBuffer.length > 0) {
      result[currentKey] = [...listBuffer];
      listBuffer.length = 0;
    }
  };

  for (const line of lines) {
    // Inline array: Tags: [a, b]
    const inlineMatch = line.match(/^([^:]+):\s*\[(.*)\]$/);
    if (inlineMatch) {
      flushList();
      currentKey = null;
      const key = inlineMatch[1].trim();
      result[key] = inlineMatch[2]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }

    // Key with value: Type: Decision
    const kvMatch = line.match(/^([^:]+):\s*(.+)$/);
    if (kvMatch && !line.startsWith("  ")) {
      flushList();
      currentKey = kvMatch[1].trim();
      const val = kvMatch[2].trim();
      if (val !== "") {
        result[currentKey] = val.replace(/^["']|["']$/g, "");
        currentKey = null;
      }
      continue;
    }

    // Key with no inline value (list follows)
    const keyOnlyMatch = line.match(/^([^:]+):\s*$/);
    if (keyOnlyMatch && !line.startsWith("  ")) {
      flushList();
      currentKey = keyOnlyMatch[1].trim();
      continue;
    }

    // List item — wikilink style: - "[[ADR-002|ADR-002]]"
    const listItemMatch = line.match(/^\s+-\s+"?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]"?$/);
    if (listItemMatch && currentKey) {
      listBuffer.push(listItemMatch[1].trim());
      continue;
    }

    // List item — plain
    const simpleItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (simpleItemMatch && currentKey) {
      listBuffer.push(simpleItemMatch[1].trim().replace(/^["']|["']$/g, ""));
    }
  }

  flushList();
  return result;
}

function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function extractFilenamePrefixes(stem: string): string[] {
  // "ADR-001 - Some Title" → ["ADR"]
  // "EVOlearn_Governance" → ["EVOlearn"]
  const parts = stem.split(/[-_ ]/);
  return parts.slice(0, 2).filter((p) => p.length >= 3 && /[A-Za-z]/.test(p));
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface TriageCheckpoint {
  completedClusters: string[];
  flags: TriageLlmFlag[];
}

const CHECKPOINT_FILENAME = "_triage-checkpoint.json";

export function readTriageCheckpoint(outputDir: string): TriageCheckpoint | null {
  const p = join(outputDir, CHECKPOINT_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TriageCheckpoint;
  } catch {
    return null;
  }
}

export function writeTriageCheckpoint(checkpoint: TriageCheckpoint, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, CHECKPOINT_FILENAME), JSON.stringify(checkpoint, null, 2), "utf-8");
}

export function deleteTriageCheckpoint(outputDir: string): void {
  const p = join(outputDir, CHECKPOINT_FILENAME);
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Triage queue writer
// ---------------------------------------------------------------------------

export function writeTriageQueue(packets: TriageReviewPacket[], outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  const queueFile = {
    generated_at: new Date().toISOString(),
    run_id: `triage-${Date.now()}`,
    packets,
  };

  writeFileSync(
    join(outputDir, "_triage-queue.json"),
    JSON.stringify(queueFile, null, 2),
    "utf-8",
  );

  writeFileSync(
    join(outputDir, "_triage-report.md"),
    renderTriageReport(packets),
    "utf-8",
  );
}

function renderTriageReport(packets: TriageReviewPacket[]): string {
  const contradictions = packets.filter((p) => p.triageFlag === "contradiction");
  const duplicates = packets.filter((p) => p.triageFlag === "duplicate");
  const stale = packets.filter((p) => p.triageFlag === "stale-reference");

  const lines: string[] = [
    "# Polaris Docs Triage Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `| Flag | Count |`,
    `|------|-------|`,
    `| contradiction | ${contradictions.length} |`,
    `| duplicate | ${duplicates.length} |`,
    `| stale-reference | ${stale.length} |`,
    `| **total** | **${packets.length}** |`,
    "",
    "## Flagged Documents",
    "",
    "This file is display-only. Edit `_triage-queue.json` to record decisions,",
    "or run `polaris docs review` to walk through them interactively.",
    "",
  ];

  for (const p of packets) {
    lines.push(`### ${p.triageFlag.toUpperCase()} · ${p.sourcePath}`);
    lines.push("");
    lines.push(`**Reason:** ${p.outcomeReason}`);
    if (p.relatedCanonical) {
      lines.push(`**Conflicts with:** ${p.relatedCanonical}`);
    }
    if (p.staleSymbols && p.staleSymbols.length > 0) {
      lines.push(`**Stale symbols:** ${p.staleSymbols.join(", ")}`);
    }
    lines.push(`**Review decision:** ${p.reviewDecision ?? "← pending"}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Placeholder exports referenced in later tasks (stubs — filled in Task 3+)
// ---------------------------------------------------------------------------

export interface TriageOptions {
  repoRoot: string;
  batchSize?: number;
  model?: string;
  resume?: boolean;
  dryRun?: boolean;
  output?: (msg: string) => void;
  llmClient?: LlmClient;
  symbolLookup?: (name: string) => boolean;
  graphStats?: () => { symbolCount: number };
}

export interface TriageResult {
  flagCount: number;
  outputDir: string;
}

export interface LlmClient {
  compare(
    candidates: DocMeta[],
    canonicals: DocMeta[],
    model: string,
  ): Promise<TriageLlmFlag[]>;
}

export interface TriageLlmFlag {
  candidatePath: string;
  flagType: "contradiction" | "duplicate";
  canonicalPath?: string;
  reason: string;
}

export interface BatchComparisonOptions {
  model: string;
  llmClient?: LlmClient;
  /** Repo root used to resolve the configured librarian-role CLI provider when
   * llmClient is not supplied. Defaults to process.cwd(). */
  repoRoot?: string;
}

export function resolveTriageModel(configured?: string): string {
  return (
    process.env["POLARIS_TRIAGE_MODEL"] ??
    configured ??
    "claude-haiku-4-5-20251001"
  );
}

export async function runBatchComparison(
  candidates: DocMeta[],
  canonicals: DocMeta[],
  options: BatchComparisonOptions,
): Promise<TriageLlmFlag[]> {
  const client = options.llmClient ?? (await buildDefaultLlmClient(options.repoRoot ?? process.cwd()));

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await client.compare(candidates, canonicals, options.model);
    } catch (err) {
      process.stderr.write(
        `[triage] LLM batch failed (attempt ${attempt + 1})${attempt === 0 ? ", retrying" : ", skipping batch"}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return [];
}

function buildComparisonPrompt(candidates: DocMeta[], canonicals: DocMeta[]): string {
  const candidateSummaries = candidates
    .map((c, i) => `[${i}] ${basename(c.path)} (${c.type || "unknown type"}) tags: ${c.tags.join(", ") || "none"}`)
    .join("\n");

  const canonicalSummaries = canonicals
    .map((c) => `- ${basename(c.path)} (${c.type || "unknown type"}) tags: ${c.tags.join(", ") || "none"}`)
    .join("\n");

  return [
    "You are comparing candidate documentation files against canonical documentation.",
    "Identify any candidates that CONTRADICT or DUPLICATE a canonical.",
    'Return ONLY a JSON array. If no issues found, return [].',
    'Each item must be: { "candidatePath": string, "flagType": "contradiction" | "duplicate", "canonicalPath"?: string, "reason": string }',
    "",
    "CANDIDATES:",
    candidateSummaries,
    "",
    "CANONICALS:",
    canonicalSummaries,
    "",
    "Respond with JSON only. No prose.",
  ].join("\n");
}

function parseFlagsFromText(text: string): TriageLlmFlag[] {
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(cleaned) as TriageLlmFlag[];
}

/** Expand $VAR and ${VAR} references from process.env. */
function expandEnvVars(str: string): string {
  return str
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? "");
}

/** Substitute {{key}} template variables. Unknown keys are left as-is. */
function substituteTemplates(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{([^}]+)\}\}/g, (original, key) => vars[key.trim()] ?? original);
}

/**
 * Resolve the configured CLI provider for triage's librarian-role LLM calls, per
 * polaris.config.json's execution.providerPolicy.librarian / execution.providers —
 * the same config the terminal-cli dispatch adapter reads for Foreman/Worker
 * sessions. Returns undefined if no usable provider is configured, in which case
 * callers fall back to a raw API-key-based client.
 */
export function resolveLibrarianProviderConfig(repoRoot: string): ProviderConfig | undefined {
  try {
    const config = loadConfig(repoRoot);
    const providers = config.execution?.providers ?? {};
    const policyNames = config.execution?.providerPolicy?.librarian?.providers ?? [];
    for (const name of policyNames) {
      const cfg = providers[name];
      if (cfg) return cfg;
    }
    // Fall back to a directly-named "claude" provider if no policy entry resolved.
    return providers["claude"];
  } catch {
    return undefined;
  }
}

/**
 * Build an LlmClient that shells out to the configured CLI provider (e.g. `claude
 * --print`), the same mechanism the terminal-cli execution adapter uses for
 * Foreman/Worker dispatch. This authenticates via the CLI's own session (OAuth),
 * not a raw ANTHROPIC_API_KEY.
 */
function buildCliLlmClient(providerCfg: ProviderConfig): LlmClient {
  return {
    async compare(candidates, canonicals) {
      const prompt = buildComparisonPrompt(candidates, canonicals);
      const templateVars: Record<string, string> = { worker_prompt: prompt };

      const command = substituteTemplates(expandEnvVars(providerCfg.command), templateVars);
      if (!command.trim()) {
        throw new Error(
          `Provider command "${providerCfg.command}" expanded to an empty string — likely an unset environment variable.`,
        );
      }
      const args = (providerCfg.args ?? []).map((arg) =>
        substituteTemplates(expandEnvVars(arg), templateVars),
      );

      const stdout = execFileSync(command, args, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000,
      });

      return parseFlagsFromText(stdout);
    },
  };
}

async function buildDefaultLlmClient(repoRoot: string): Promise<LlmClient> {
  const cliProviderCfg = resolveLibrarianProviderConfig(repoRoot);
  if (cliProviderCfg) {
    return buildCliLlmClient(cliProviderCfg);
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
  if (!apiKey) {
    throw new Error(
      "No CLI provider configured for the librarian role (execution.providerPolicy.librarian / " +
        "execution.providers in polaris.config.json) and ANTHROPIC_API_KEY is not set. " +
        "Configure a librarian provider (preferred — uses the CLI's own session auth) or set " +
        "ANTHROPIC_API_KEY as a fallback.",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // @ts-ignore: @anthropic-ai/sdk may not be installed as a dependency
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default ?? mod.Anthropic;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkClient = new Anthropic({ apiKey }) as any;

  return {
    async compare(candidates, canonicals, model) {
      const prompt = buildComparisonPrompt(candidates, canonicals);

      const response = await sdkClient.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const text = (response.content as { type: string; text: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      return parseFlagsFromText(text);
    },
  };
}

export interface GraphCheckOptions {
  getContent: (path: string) => string;
  symbolLookup: (name: string) => boolean;
  graphStats: () => { symbolCount: number };
}

export interface GraphFlag {
  candidatePath: string;
  flagType: "stale-reference";
  staleSymbols: string[];
}

const STALE_SYMBOL_THRESHOLD = 2;
const GRAPH_SYMBOL_MINIMUM = 1000;

export function runGraphCheck(
  candidates: DocMeta[],
  options: GraphCheckOptions,
): GraphFlag[] {
  const stats = options.graphStats();

  if (stats.symbolCount < GRAPH_SYMBOL_MINIMUM) {
    process.stderr.write(
      `[triage] Graph coverage too low for doc-vs-code check (${stats.symbolCount} symbols indexed).\n` +
      `         Run: polaris-cli graph build\n`,
    );
    return [];
  }

  const flags: GraphFlag[] = [];

  for (const candidate of candidates) {
    let content = "";
    try {
      content = options.getContent(candidate.path);
    } catch {
      continue;
    }

    const symbols = extractSymbols(content);
    const missing = symbols.filter((s) => !options.symbolLookup(s));

    if (missing.length >= STALE_SYMBOL_THRESHOLD) {
      flags.push({
        candidatePath: candidate.path,
        flagType: "stale-reference",
        staleSymbols: missing,
      });
    }
  }

  return flags;
}

export async function runTriage(options: TriageOptions): Promise<TriageResult> {
  const {
    repoRoot,
    batchSize = 10,
    dryRun = false,
    output = (m: string) => process.stdout.write(m + "\n"),
    llmClient,
    symbolLookup,
    graphStats,
  } = options;

  const activeDir = join(repoRoot, "smartdocs", "doctrine", "active");
  const candidateDir = join(repoRoot, "smartdocs", "doctrine", "candidate");
  const outputDir = join(repoRoot, "smartdocs", "raw");

  output(`Loading canonical docs from ${activeDir}...`);
  const canonicals = loadAllDocMeta(activeDir);

  output(`Loading candidate docs from ${candidateDir}...`);
  const candidates = loadAllDocMeta(candidateDir);

  output(`Clustering ${candidates.length} candidates against ${canonicals.length} canonicals...`);
  const clusterMap = clusterCandidates(candidates, canonicals);

  const clusterNames = Object.keys(clusterMap).filter((k) => k !== "general");
  if (clusterMap["general"]) clusterNames.push("general");

  if (dryRun) {
    const batchCount = clusterNames.reduce((sum, name) => {
      return sum + Math.ceil((clusterMap[name].candidates.length || 0) / batchSize);
    }, 0);
    output(`  ${clusterNames.length} clusters identified`);
    output(`  Estimated batches: ${batchCount}`);
    output(`  Estimated tokens: ~${batchCount * 3000} input / ~${batchCount * 200} output`);
    output(`  Model: ${resolveTriageModel(options.model)} (configured)`);
    output(`\nRun without --dry-run to execute.`);
    return { flagCount: 0, outputDir };
  }

  let checkpoint = readTriageCheckpoint(outputDir);
  const completedClusters = new Set(checkpoint?.completedClusters ?? []);
  const accumulatedFlags: TriageLlmFlag[] = [...(checkpoint?.flags ?? [])];

  if (completedClusters.size > 0) {
    output(`Resuming triage from checkpoint (${completedClusters.size}/${clusterNames.length} clusters complete)...`);
  }

  const model = resolveTriageModel(options.model);

  // Phase 1: doc-vs-doc
  for (const clusterName of clusterNames) {
    if (completedClusters.has(clusterName)) continue;

    const cluster = clusterMap[clusterName];
    if (cluster.candidates.length === 0) {
      completedClusters.add(clusterName);
      continue;
    }

    output(`  Comparing cluster "${clusterName}" (${cluster.candidates.length} candidates, ${cluster.canonicals.length} canonicals)...`);

    for (let i = 0; i < cluster.candidates.length; i += batchSize) {
      const batch = cluster.candidates.slice(i, i + batchSize);
      const flags = await runBatchComparison(batch, cluster.canonicals, { model, llmClient, repoRoot });
      accumulatedFlags.push(...flags);
    }

    completedClusters.add(clusterName);
    writeTriageCheckpoint(
      { completedClusters: Array.from(completedClusters), flags: accumulatedFlags },
      outputDir,
    );
  }

  // Phase 2: doc-vs-code
  output(`Running doc-vs-code graph check...`);
  const graphCheckOptions: GraphCheckOptions = {
    getContent: (p) => readFileSync(p, "utf-8"),
    symbolLookup: symbolLookup ?? ((name: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { lookupSymbol } = require("../graph/query/index.js") as { lookupSymbol: (n: string) => unknown };
      return lookupSymbol(name) !== null;
    }),
    graphStats: graphStats ?? (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getGraphStats } = require("../graph/query/index.js") as { getGraphStats: () => { symbolCount: number } };
      return getGraphStats();
    }),
  };

  const graphFlags = runGraphCheck(candidates, graphCheckOptions);

  const allPackets: TriageReviewPacket[] = [
    ...accumulatedFlags.map((f): TriageReviewPacket => ({
      sourcePath: f.candidatePath,
      proposedDestination: f.candidatePath,
      classificationConfidence: 0,
      destinationCertainty: 0,
      authorityRisk: "medium",
      reasoning: [f.reason],
      conflicts: f.canonicalPath ? [f.canonicalPath] : [],
      recommendation: "defer",
      outcomeReason: f.reason,
      triageFlag: f.flagType,
      relatedCanonical: f.canonicalPath,
    })),
    ...graphFlags.map((f): TriageReviewPacket => ({
      sourcePath: f.candidatePath,
      proposedDestination: f.candidatePath,
      classificationConfidence: 0,
      destinationCertainty: 0,
      authorityRisk: "low",
      reasoning: [`Stale symbol references: ${f.staleSymbols.join(", ")}`],
      conflicts: [],
      recommendation: "defer",
      outcomeReason: `${f.staleSymbols.length} code symbols not found in graph: ${f.staleSymbols.join(", ")}`,
      triageFlag: "stale-reference",
      staleSymbols: f.staleSymbols,
    })),
  ];

  writeTriageQueue(allPackets, outputDir);
  deleteTriageCheckpoint(outputDir);

  output(`\nTriage complete: ${allPackets.length} flags written to ${outputDir}/_triage-queue.json`);
  output(`Run \`polaris docs review\` to walk through decisions.`);

  return { flagCount: allPackets.length, outputDir };
}
