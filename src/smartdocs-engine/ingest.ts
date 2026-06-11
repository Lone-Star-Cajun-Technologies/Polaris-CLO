import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import {
  readFileRoutes,
  readNeedsReview,
  writeFileRoutes,
  writeAtlasIndex,
  computeInstructionCoverage,
  type FileRouteEntry,
} from "../map/atlas.js";
import { getMonotonicTimestamp } from "../utils/monotonic-timestamp.js";
import { isIngestIneligible } from "./smartdoc-ignore.js";
import { stampIngestFrontMatter } from "./doctrine.js";
import { applySummaryDelta, findNearestSummarymd, detectPrecedenceLevel } from "../cognition/summary-delta.js";

export type DocsClassification =
  | "runtime-summary"
  | "run-report"
  | "spec-raw"
  | "spec-active"
  | "audit-finding"
  | "doctrine-candidate"
  | "architecture"
  | "decision"
  | "deprecated-noise";

export interface IngestOptions {
  repoRoot: string;
  dryRun?: boolean;
  clusterId?: string;
  maxFiles?: number;
  approveAuthority?: boolean;
}

export interface IngestResult {
  sourcePath: string;
  destinationPath: string;
  classification: DocsClassification;
  linkedMapArea: string | null;
  runId: string;
  dryRun: boolean;
  /** Relative path of the nearest route SUMMARY.md that may need updating. */
  nearestSummary: string | null;
  /** Whether the ingest triggered a SUMMARY.md delta (informational only). */
  summaryDeltaWarranted: boolean;
}

export interface DocsScaffoldResult {
  created: string[];
  existing: string[];
  dryRun: boolean;
}

interface DocsIngestState {
  run_id?: string;
  prior_run_id?: string | null;
  cluster_id?: string | null;
  status?: string;
  files_ingested?: number;
  last_run_at?: string;
}

export const CANONICAL_TARGET = "smartdocs";
const DOCS_INGEST_STATE_FILE = ".taskchain_artifacts/polaris-docs-ingest/current-state.json";
const DOCS_INGEST_RUNS_DIR = ".taskchain_artifacts/polaris-docs-ingest/runs";
const DEFAULT_BATCH_LIMIT = 4;

const TARGET_DIRS: Record<DocsClassification, string> = {
  "runtime-summary": `${CANONICAL_TARGET}/runtime/summaries`,
  "run-report": `${CANONICAL_TARGET}/runtime/run-reports`,
  "spec-raw": `${CANONICAL_TARGET}/raw`,
  "spec-active": `${CANONICAL_TARGET}/specs/active`,
  "audit-finding": `${CANONICAL_TARGET}/audits/findings`,
  "doctrine-candidate": `${CANONICAL_TARGET}/doctrine/candidate`,
  architecture: `${CANONICAL_TARGET}/architecture`,
  decision: `${CANONICAL_TARGET}/decisions`,
  "deprecated-noise": `${CANONICAL_TARGET}/runtime/generated`,
};

export const SMART_DOCS_SCAFFOLD_DIRS = [
  CANONICAL_TARGET,
  ...Object.values(TARGET_DIRS),
  `${CANONICAL_TARGET}/raw`,
  `${CANONICAL_TARGET}/specs/implemented`,
  `${CANONICAL_TARGET}/specs/superseded`,
  `${CANONICAL_TARGET}/audits/resolved`,
  `${CANONICAL_TARGET}/doctrine/active`,
  `${CANONICAL_TARGET}/doctrine/deprecated`,
];

const APPROVAL_REQUIRED = new Set<DocsClassification>(["spec-active", "architecture", "decision"]);

/**
 * Conflict detection uses subject-verb-keyword triples rather than bare
 * verb-keyword pairs. A conflict only fires when both the subject AND the
 * keyword match between the ingested doc and an active doctrine file.
 * This prevents false positives such as:
 *   doctrine:  "SUMMARY.md must contain (standard schema)"
 *   ingested:  "Workers must not contain stale assumptions"
 * — same keyword (`contain`), completely different subjects.
 */
const MODAL_REQUIRES_RE = /([A-Za-z][\w/.\-]{0,40})\s+(?:must|always)\s+(\w+)/gi;
const MODAL_PROHIBITS_RE = /([A-Za-z][\w/.\-]{0,40})\s+(?:never|must\s+not)\s+(\w+)/gi;
const CONFLICT_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "been", "will", "when", "then",
  "else", "each", "every", "also", "note", "not", "used", "only", "be",
  "are", "the", "and", "for", "its", "any", "all",
]);

/** A (normalised-subject, verb-keyword) pair extracted from content. */
interface VerbTriple {
  subject: string;
  keyword: string;
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as Error & { code?: string }).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function frontMatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const lines = content.slice(4, end).split(/\r?\n/);
  const found = lines.find((line) => line.toLowerCase().startsWith(`${key.toLowerCase()}:`));
  return found?.slice(found.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
}

export function classifyDoc(content: string, filePath = ""): DocsClassification {
  const lower = `${filePath}\n${content}`.toLowerCase();
  const status = frontMatterValue(content, "status")?.toLowerCase();
  const authority = frontMatterValue(content, "authority")?.toLowerCase();

  if (basename(filePath).toLowerCase() === "summary.md") {
    return "deprecated-noise";
  }

  if (status === "deprecated" || lower.includes("deprecated noise") || lower.includes("obsolete")) {
    return "deprecated-noise";
  }
  if (lower.includes("run report") || lower.includes("run-report")) return "run-report";
  if (lower.includes("runtime summary") || lower.includes("session summary")) return "runtime-summary";
  if (lower.includes("audit finding") || lower.includes("vulnerability") || lower.includes("security audit")) {
    return "audit-finding";
  }
  if (authority === "doctrine" || lower.includes("doctrine") || lower.includes("must always") || lower.includes("never silently")) {
    return "doctrine-candidate";
  }
  if (lower.includes("architecture decision record") || /^#\s*adr[:\s-]/im.test(content)) return "decision";
  if (authority === "architecture" || lower.includes("architecture") || lower.includes("structural design")) return "architecture";
  if (status === "active" || lower.includes("active spec")) return "spec-active";
  if (lower.includes("spec") || lower.includes("acceptance criteria") || lower.includes("implementation plan")) {
    return "spec-raw";
  }
  return "spec-raw";
}

function readCurrentState(repoRoot: string): DocsIngestState {
  return readJson(resolve(repoRoot, DOCS_INGEST_STATE_FILE), {});
}

function generateRunId(repoRoot: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const runsDir = resolve(repoRoot, DOCS_INGEST_RUNS_DIR);
  let seq = 1;
  if (existsSync(runsDir)) {
    try {
      const existing = readdirSync(runsDir).filter((d) => d.includes(date));
      const suffixes = existing
        .map((d) => {
          const match = d.match(/-(\d{3})$/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter((n) => !isNaN(n) && n > 0);
      const maxSuffix = suffixes.length > 0 ? Math.max(...suffixes) : 0;
      seq = maxSuffix + 1;
    } catch {
      // use seq = 1
    }
  }
  return `polaris-docs-ingest-docs-ingest-${date}-${String(seq).padStart(3, "0")}`;
}

function docsIngestTelemetryPath(repoRoot: string, runId: string): string {
  return resolve(repoRoot, DOCS_INGEST_RUNS_DIR, runId, "telemetry.jsonl");
}

function emitRunStartTelemetry(repoRoot: string, runId: string, priorRunId: string | null): void {
  const telPath = docsIngestTelemetryPath(repoRoot, runId);
  mkdirSync(dirname(telPath), { recursive: true });
  appendFileSync(
    telPath,
    JSON.stringify({
      event: "run-start",
      run_id: runId,
      prior_run_id: priorRunId,
      timestamp: getMonotonicTimestamp(),
    }) + "\n",
    "utf-8",
  );
}

function emitTelemetry(telPath: string, runId: string, event: Record<string, unknown>): void {
  try {
    appendFileSync(
      telPath,
      JSON.stringify({ ...event, run_id: runId, timestamp: getMonotonicTimestamp() }) + "\n",
      "utf-8",
    );
  } catch {
    // non-fatal for post-run-start events
  }
}

function writeDocsIngestState(repoRoot: string, state: DocsIngestState): void {
  const statePath = resolve(repoRoot, DOCS_INGEST_STATE_FILE);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function ensureDocsScaffold(repoRoot: string, options: { dryRun?: boolean } = {}): DocsScaffoldResult {
  const created = SMART_DOCS_SCAFFOLD_DIRS.filter((dir) => !existsSync(resolve(repoRoot, dir)));
  const existing = SMART_DOCS_SCAFFOLD_DIRS.filter((dir) => existsSync(resolve(repoRoot, dir)));

  if (!options.dryRun) {
    for (const dir of created) {
      mkdirSync(resolve(repoRoot, dir), { recursive: true });
    }
  }

  return {
    created,
    existing,
    dryRun: Boolean(options.dryRun),
  };
}

function uniqueDestination(filePath: string): string {
  if (!existsSync(filePath)) return filePath;
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const stem = basename(filePath, ext);
  let index = 2;
  let candidate = join(dir, `${stem}-${index}${ext}`);
  while (existsSync(candidate)) {
    index += 1;
    candidate = join(dir, `${stem}-${index}${ext}`);
  }
  return candidate;
}

function deriveLinkedArea(
  content: string,
  routes: Record<string, FileRouteEntry>,
): { label: string | null; entry: FileRouteEntry | null } {
  const entries = Object.entries(routes);
  const explicit = entries.find(([filePath]) => content.includes(filePath));
  if (explicit) {
    return { label: explicit[1].route || explicit[0], entry: explicit[1] };
  }

  const area = content.match(/\b(src\/[A-Za-z0-9_/-]+)/)?.[1];
  if (area) {
    const matched = entries.find(([filePath]) => filePath.startsWith(area));
    if (matched) return { label: matched[1].route || area, entry: matched[1] };
    return { label: area, entry: null };
  }

  return { label: null, entry: null };
}

function updateMapEntry(
  repoRoot: string,
  destinationPath: string,
  linkedEntry: FileRouteEntry | null,
): void {
  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const routes = readFileRoutes(atlasPath);
  const relDestination = relative(repoRoot, destinationPath).replace(/\\/g, "/");
  const now = new Date().toISOString();

  routes[relDestination] = {
    domain: linkedEntry?.domain ?? "docs",
    route: linkedEntry?.route ?? dirname(relDestination),
    taskchain: linkedEntry?.taskchain ?? "polaris-docs",
    confidence: linkedEntry ? 0.85 : 0.7,
    classification: "indexed",
    last_updated: now,
    updated_by: "polaris-docs-ingest",
    tags: ["docs", "ingested"],
    instructionFile: linkedEntry?.instructionFile,
  };

  writeFileRoutes(atlasPath, routes);
  const needsReview = readNeedsReview(atlasPath);
  const entries = { ...routes, ...needsReview };
  const instructionCoverage = computeInstructionCoverage(entries);
  writeAtlasIndex(atlasPath, {
    scan_date: now,
    file_count: Object.keys(entries).length,
    coverage_pct: Math.round((Object.values(entries).filter((e) => e.classification === "indexed").length / Object.keys(entries).length) * 100),
    instructionCoverage,
    entries,
  });
}

function extractVerbTriples(content: string, pattern: RegExp): VerbTriple[] {
  const result: VerbTriple[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  for (const match of content.matchAll(re)) {
    const subject = match[1]?.toLowerCase().replace(/[^a-z0-9./\-]/g, "");
    const keyword = match[2]?.toLowerCase();
    if (
      subject && keyword &&
      keyword.length >= 3 &&
      !CONFLICT_STOPWORDS.has(keyword) &&
      !CONFLICT_STOPWORDS.has(subject)
    ) {
      result.push({ subject, keyword });
    }
  }
  return result;
}

/** Returns true if two triple sets share a (subject, keyword) pair. */
function triplesConflict(a: VerbTriple[], b: VerbTriple[]): { subject: string; keyword: string } | null {
  for (const ta of a) {
    for (const tb of b) {
      if (ta.subject === tb.subject && ta.keyword === tb.keyword) {
        return { subject: ta.subject, keyword: ta.keyword };
      }
    }
  }
  return null;
}

function detectDoctrineConflict(
  content: string,
  repoRoot: string,
): { conflictingFile: string; detail: string } | null {
  const activeDoctrineDir = resolve(repoRoot, CANONICAL_TARGET, "doctrine", "active");
  if (!existsSync(activeDoctrineDir)) return null;

  let files: string[];
  try {
    files = readdirSync(activeDoctrineDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  const ingestedRequires = extractVerbTriples(content, MODAL_REQUIRES_RE);
  const ingestedProhibits = extractVerbTriples(content, MODAL_PROHIBITS_RE);

  for (const file of files) {
    let docContent: string;
    try {
      docContent = readFileSync(join(activeDoctrineDir, file), "utf-8");
    } catch {
      continue;
    }

    const docRequires = extractVerbTriples(docContent, MODAL_REQUIRES_RE);
    const docProhibits = extractVerbTriples(docContent, MODAL_PROHIBITS_RE);

    // ingested prohibits X; doctrine requires X — same subject
    const prohibitConflict = triplesConflict(ingestedProhibits, docRequires);
    if (prohibitConflict) {
      return {
        conflictingFile: file,
        detail: `ingested doc prohibits "${prohibitConflict.keyword}" for "${prohibitConflict.subject}" but ${file} requires it`,
      };
    }

    // ingested requires X; doctrine prohibits X — same subject
    const requireConflict = triplesConflict(ingestedRequires, docProhibits);
    if (requireConflict) {
      return {
        conflictingFile: file,
        detail: `ingested doc requires "${requireConflict.keyword}" for "${requireConflict.subject}" but ${file} prohibits it`,
      };
    }
  }

  return null;
}

export function ingestDocs(files: string[], options: IngestOptions): IngestResult[] {
  const repoRoot = resolve(options.repoRoot);

  // Canonical target check (STOP CONDITION)
  const canonicalDir = resolve(repoRoot, CANONICAL_TARGET);
  if (!existsSync(canonicalDir)) {
    throw new Error(`polaris docs ingest: canonical target ${CANONICAL_TARGET}/ not found — halting`);
  }

  const limit = options.maxFiles ?? DEFAULT_BATCH_LIMIT;
  if (files.length === 0) throw new Error("polaris docs ingest: provide at least one file");
  if (files.length > limit) throw new Error(`polaris docs ingest: batch limit is ${limit} files`);

  const priorState = readCurrentState(repoRoot);
  const clusterId = options.clusterId ?? null;
  const runId = generateRunId(repoRoot);

  // Emit run-start telemetry (STOP CONDITION if this write fails)
  emitRunStartTelemetry(repoRoot, runId, priorState.run_id ?? null);
  const telPath = docsIngestTelemetryPath(repoRoot, runId);

  ensureDocsScaffold(repoRoot);

  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const routes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };

  const results: IngestResult[] = [];

  for (const source of files) {
    const absSource = resolve(repoRoot, source);
    const relCheck = relative(repoRoot, absSource);
    if (relCheck.startsWith("..") || relCheck.startsWith("/")) {
      throw new Error(`polaris docs ingest: path traversal detected, file outside repo: ${source}`);
    }
    const relSource = relative(repoRoot, absSource).replace(/\\/g, "/");

    if (basename(relSource).toLowerCase() === "summary.md") {
      throw new Error(`polaris docs ingest: SUMMARY.md is an endpoint artifact and cannot be ingested`);
    }

    const eligibility = isIngestIneligible(relSource, repoRoot);
    if (eligibility.ineligible) {
      emitTelemetry(telPath, runId, {
        event: "docs-ingest-skipped-endpoint-artifact",
        file: relSource,
        reason: eligibility.reason,
        cluster_id: clusterId,
      });
      throw new Error(`polaris docs ingest: ${relSource} is ineligible for docs ingest - ${eligibility.reason}`);
    }
    if (!existsSync(absSource)) throw new Error(`polaris docs ingest: file not found: ${source}`);
    const content = readFileSync(absSource, "utf-8");
    const classification = classifyDoc(content, relSource);

    if (APPROVAL_REQUIRED.has(classification) && !options.approveAuthority) {
      throw new Error(`polaris docs ingest: ${classification} requires explicit approval; rerun with --approve-authority`);
    }

    // Conflict detection against active doctrine (STOP CONDITION)
    const conflict = detectDoctrineConflict(content, repoRoot);
    if (conflict) {
      emitTelemetry(telPath, runId, {
        event: "docs-ingest-conflict-detected",
        file: relSource,
        conflicting_doctrine_file: conflict.conflictingFile,
        detail: conflict.detail,
        cluster_id: clusterId,
      });
      throw new Error(`polaris docs ingest: conflict detected — ${conflict.detail}`);
    }

    const { label: linkedMapArea, entry: linkedEntry } = deriveLinkedArea(content, routes);
    const targetDir = resolve(repoRoot, TARGET_DIRS[classification]);
    mkdirSync(targetDir, { recursive: true });
    const rawDestination = join(targetDir, basename(absSource));
    const destination = resolve(rawDestination) === resolve(absSource)
      ? absSource
      : uniqueDestination(rawDestination);
    const relDestination = relative(repoRoot, destination).replace(/\\/g, "/");
    const provenancePath = /\.md$/i.test(destination)
      ? destination.replace(/\.md$/i, ".provenance.json")
      : `${destination}.provenance.json`;

    emitTelemetry(telPath, runId, {
      event: "docs-ingest-classified",
      file: relSource,
      classification,
      destination: relDestination,
      linked_map_area: linkedMapArea,
      cluster_id: clusterId,
    });

    if (!options.dryRun) {
      if (resolve(absSource) !== resolve(destination)) {
        renameSync(absSource, destination);
      }
      const stampedContent = stampIngestFrontMatter(
        readFileSync(destination, "utf-8"),
        {
          originalPath: relSource,
          classifiedAs: classification,
          ingestRunId: runId,
          ingestClusterId: clusterId,
          linkedMapArea,
          ingestedAt: new Date().toISOString(),
        },
      );
      writeFileSync(destination, stampedContent, "utf-8");
      updateMapEntry(repoRoot, destination, linkedEntry);
    }

    if (classification === "doctrine-candidate" && !options.dryRun) {
      emitTelemetry(telPath, runId, {
        event: "doc-auto-promoted",
        file: relDestination,
        classification,
        linked_map_area: linkedMapArea,
        cluster_id: clusterId,
      });
    }

    emitTelemetry(telPath, runId, {
      event: "docs-ingest",
      file: relSource,
      classification,
      destination: relDestination,
      linked_map_area: linkedMapArea,
      cluster_id: clusterId,
    });

    // ── SUMMARY.md delta check ────────────────────────────────────────────
    // Associate the ingested doc with its nearest route SUMMARY.md and
    // determine whether a SUMMARY.md update is warranted. Informational only —
    // never promotes SUMMARY.md into canon or doctrine.
    const summaryDelta = applySummaryDelta({
      repoRoot,
      touchedFiles: [relDestination],
      skipRoot: true,
    });
    const nearestSummary = findNearestSummarymd(relDestination, repoRoot, true);
    if (summaryDelta.updateWarranted) {
      emitTelemetry(telPath, runId, {
        event: "summary-delta-warranted",
        file: relDestination,
        reasons: summaryDelta.reasons,
        precedence_source: summaryDelta.precedenceSource,
        summary_target: nearestSummary,
        cluster_id: clusterId,
      });
    }

    // ── Promoted-doc route detection ──────────────────────────────────────
    // When a doc lands in an active doctrine or spec path, it becomes the
    // preferred cognition source for nearby routes. Emit a lightweight
    // cognition-maintenance-needed event so operators/workers can act.
    // Does NOT write any file; informational only.
    const precedence = detectPrecedenceLevel([relDestination]);
    if (precedence === "promoted-doctrine" || precedence === "spec-or-arch") {
      if (nearestSummary) {
        emitTelemetry(telPath, runId, {
          event: "cognition-maintenance-needed",
          trigger: "doc-promotion",
          promoted_file: relDestination,
          precedence_source: precedence,
          affected_summary: nearestSummary,
          cluster_id: clusterId,
        });
      }
    }

    results.push({
      sourcePath: relSource,
      destinationPath: relDestination,
      classification,
      linkedMapArea,
      runId,
      dryRun: Boolean(options.dryRun),
      nearestSummary,
      summaryDeltaWarranted: summaryDelta.updateWarranted,
    });
  }

  emitTelemetry(telPath, runId, {
    event: "docs-ingest-complete",
    count: results.length,
    cluster_id: clusterId,
  });

  if (!options.dryRun) {
    writeDocsIngestState(repoRoot, {
      run_id: runId,
      prior_run_id: priorState.run_id ?? null,
      cluster_id: clusterId ?? undefined,
      status: "complete",
      files_ingested: results.length,
      last_run_at: new Date().toISOString(),
    });
  }

  return results;
}

export function printIngestResults(results: IngestResult[]): void {
  for (const result of results) {
    const prefix = result.dryRun ? "[dry-run] " : "";
    console.log(`${prefix}${result.sourcePath} -> ${result.destinationPath}`);
    console.log(`classification: ${result.classification}`);
    console.log(`linked_map_area: ${result.linkedMapArea ?? "none"}`);
    console.log(`run_id: ${result.runId}`);
    if (result.nearestSummary) console.log(`nearest_summary: ${result.nearestSummary}${result.summaryDeltaWarranted ? " (delta warranted)" : ""}`);
  }
}
