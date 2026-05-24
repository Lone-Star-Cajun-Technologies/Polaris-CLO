import {
  appendFileSync,
  existsSync,
  mkdirSync,
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
  runId: string | null;
  provenancePath: string | null;
  dryRun: boolean;
}

interface CurrentState {
  run_id?: string;
  cluster_id?: string;
}

const DEFAULT_BATCH_LIMIT = 4;

const TARGET_DIRS: Record<DocsClassification, string> = {
  "runtime-summary": "docs/runtime/summaries",
  "run-report": "docs/runtime/run-reports",
  "spec-raw": "docs/specs/raw",
  "spec-active": "docs/specs/active",
  "audit-finding": "docs/audits/findings",
  "doctrine-candidate": "docs/doctrine/candidate",
  architecture: "docs/architecture",
  decision: "docs/decisions",
  "deprecated-noise": "docs/runtime/generated",
};

const APPROVAL_REQUIRED = new Set<DocsClassification>(["spec-active", "architecture", "decision"]);

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

function ensureDocsScaffold(repoRoot: string): void {
  for (const dir of Object.values(TARGET_DIRS)) {
    mkdirSync(resolve(repoRoot, dir), { recursive: true });
  }
  for (const dir of [
    "docs/raw",
    "docs/specs/implemented",
    "docs/specs/superseded",
    "docs/audits/raw",
    "docs/audits/resolved",
    "docs/doctrine/raw",
    "docs/doctrine/active",
    "docs/doctrine/deprecated",
  ]) {
    mkdirSync(resolve(repoRoot, dir), { recursive: true });
  }
}

function readCurrentState(repoRoot: string): CurrentState {
  return readJson(resolve(repoRoot, ".taskchain_artifacts/polaris-run/current-state.json"), {});
}

function telemetryPath(repoRoot: string, runId: string | null): string | null {
  if (!runId) return null;
  return resolve(repoRoot, ".taskchain_artifacts/polaris-run/runs", runId, "telemetry.jsonl");
}

function emitTelemetry(repoRoot: string, runId: string | null, event: Record<string, unknown>): void {
  const path = telemetryPath(repoRoot, runId);
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ...event, run_id: runId, timestamp: new Date().toISOString() })}\n`, "utf-8");
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

function addCandidateFrontMatter(content: string, originalPath: string): string {
  if (content.startsWith("---\n")) return content;
  const today = new Date().toISOString().slice(0, 10);
  return [
    "---",
    "status: candidate",
    `candidate-since: ${today}`,
    `source: ${originalPath}`,
    "---",
    "",
    content,
  ].join("\n");
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

export function ingestDocs(files: string[], options: IngestOptions): IngestResult[] {
  const repoRoot = resolve(options.repoRoot);
  const limit = options.maxFiles ?? DEFAULT_BATCH_LIMIT;
  if (files.length === 0) throw new Error("polaris docs ingest: provide at least one file");
  if (files.length > limit) throw new Error(`polaris docs ingest: batch limit is ${limit} files`);

  ensureDocsScaffold(repoRoot);
  const state = readCurrentState(repoRoot);
  const runId = state.run_id ?? null;
  const clusterId = options.clusterId ?? state.cluster_id ?? null;
  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const routes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };

  emitTelemetry(repoRoot, runId, {
    event: "docs-ingest-start",
    file: files[0],
    count: files.length,
    cluster_id: clusterId,
  });

  const results: IngestResult[] = [];

  for (const source of files) {
    const absSource = resolve(repoRoot, source);
    // Path traversal check: ensure absSource is within repoRoot
    const relCheck = relative(repoRoot, absSource);
    if (relCheck.startsWith("..") || relCheck.startsWith("/")) {
      throw new Error(`polaris docs ingest: path traversal detected, file outside repo: ${source}`);
    }
    if (!existsSync(absSource)) throw new Error(`polaris docs ingest: file not found: ${source}`);
    const content = readFileSync(absSource, "utf-8");
    const relSource = relative(repoRoot, absSource).replace(/\\/g, "/");
    const classification = classifyDoc(content, relSource);
    if (APPROVAL_REQUIRED.has(classification) && !options.approveAuthority) {
      throw new Error(`polaris docs ingest: ${classification} requires explicit approval; rerun with --approve-authority`);
    }

    const { label: linkedMapArea, entry: linkedEntry } = deriveLinkedArea(content, routes);
    const targetDir = resolve(repoRoot, TARGET_DIRS[classification]);
    mkdirSync(targetDir, { recursive: true });
    const destination = uniqueDestination(join(targetDir, basename(absSource)));
    const relDestination = relative(repoRoot, destination).replace(/\\/g, "/");
    // Fix: only replace .md suffix if present, otherwise append .provenance.json
    const provenancePath = /\.md$/i.test(destination)
      ? destination.replace(/\.md$/i, ".provenance.json")
      : `${destination}.provenance.json`;

    emitTelemetry(repoRoot, runId, {
      event: "docs-ingest-classified",
      file: relSource,
      classification,
      destination: relDestination,
      linked_map_area: linkedMapArea,
      cluster_id: clusterId,
    });

    if (!options.dryRun) {
      const output = classification === "doctrine-candidate" ? addCandidateFrontMatter(content, relSource) : content;
      if (output !== content) {
        writeFileSync(absSource, output, "utf-8");
      }
      renameSync(absSource, destination);
      writeFileSync(
        provenancePath,
        JSON.stringify(
          {
            currentPath: relDestination,
            originalPath: relSource,
            ingestedAt: new Date().toISOString(),
            ingestRunId: runId,
            ingestClusterId: clusterId,
            relatedRunId: runId,
            relatedIssue: state.cluster_id ?? null,
            classifiedAs: classification,
            linkedMapArea,
            conflictsDetected: false,
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
      updateMapEntry(repoRoot, destination, linkedEntry);
    }

    if (classification === "doctrine-candidate") {
      emitTelemetry(repoRoot, runId, {
        event: "doctrine-candidate-proposed",
        file: relDestination,
        cluster_id: clusterId,
      });
    }

    emitTelemetry(repoRoot, runId, {
      event: "docs-ingest",
      file: relSource,
      classification,
      destination: relDestination,
      linked_map_area: linkedMapArea,
      cluster_id: clusterId,
    });

    results.push({
      sourcePath: relSource,
      destinationPath: relDestination,
      classification,
      linkedMapArea,
      runId,
      provenancePath: options.dryRun ? null : relative(repoRoot, provenancePath).replace(/\\/g, "/"),
      dryRun: Boolean(options.dryRun),
    });
  }

  emitTelemetry(repoRoot, runId, {
    event: "docs-ingest-complete",
    file: files[files.length - 1],
    count: files.length,
    cluster_id: clusterId,
  });

  return results;
}

export function printIngestResults(results: IngestResult[]): void {
  for (const result of results) {
    const prefix = result.dryRun ? "[dry-run] " : "";
    console.log(`${prefix}${result.sourcePath} -> ${result.destinationPath}`);
    console.log(`classification: ${result.classification}`);
    console.log(`linked_map_area: ${result.linkedMapArea ?? "none"}`);
    console.log(`run_id: ${result.runId ?? "none"}`);
    if (result.provenancePath) console.log(`provenance: ${result.provenancePath}`);
  }
}
