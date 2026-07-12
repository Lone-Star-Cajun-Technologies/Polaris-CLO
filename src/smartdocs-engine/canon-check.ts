import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, Dirent } from "node:fs";
import { join, dirname, resolve, basename, relative } from "node:path";
import { checkSmartDocsLinks } from "./doctrine.js";
import type { SpecConflict } from "./doctrine.js";

export type CanonOutcome =
  | "aligned"
  | "candidate-divergence"
  | "stale-implementation"
  | "stale-docs";

export interface CanonConflict {
  type: Exclude<CanonOutcome, "aligned">;
  canonFile: string;
  statement: string;
  changedFile: string;
  detail: string;
}

export interface CanonCheckResult {
  outcome: CanonOutcome;
  conflicts: CanonConflict[];
  canonFilesInspected: number;
}

export interface CanonCheckOptions {
  repoRoot: string;
  changedFiles: string[];
  childId?: string;
  runId: string;
  telemetryFile: string;
}

// Modal verbs that indicate behavioral assertions in doctrine/spec files
const MODAL_VERBS = /\b(must|never|always|should|required|requires|shall)\b/i;

// Domains matched by filename keywords
const DOMAIN_KEYWORDS = ["loop", "map", "finalize", "config", "cli", "docs"];

/** Walk up from `startDir` to `repoRoot` looking for the nearest POLARIS.md */
function findNearestPolarisMd(startDir: string, repoRoot: string): string | null {
  let dir = resolve(startDir);
  const root = resolve(repoRoot);
  let searching = true;
  while (searching) {
    const candidate = join(dir, "POLARIS.md");
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) { searching = false; break; } // filesystem root
    dir = parent;
  }
  return null;
}

/** Collect all relevant canon files for the given changed files */
function locateCanonFiles(changedFiles: string[], repoRoot: string): Set<string> {
  const canon = new Set<string>();

  // POLARIS.md files — nearest ancestor for each changed file
  for (const f of changedFiles) {
    if (basename(f).toLowerCase() === "summary.md") continue;
    const absFile = resolve(repoRoot, f);
    const startDir = dirname(absFile);
    const polarisMd = findNearestPolarisMd(startDir, repoRoot);
    if (polarisMd) canon.add(polarisMd);
  }

  // Active doctrine
  const doctrineDir = join(repoRoot, "smartdocs", "doctrine", "active");
  if (existsSync(doctrineDir)) {
    for (const f of readdirSync(doctrineDir)) {
      if (f.endsWith(".md") && basename(f).toLowerCase() !== "summary.md") canon.add(join(doctrineDir, f));
    }
  }

  // Active and implemented specs — filtered by domain keyword overlap
  const changedDomains = new Set<string>();
  for (const f of changedFiles) {
    if (basename(f).toLowerCase() === "summary.md") continue;
    for (const kw of DOMAIN_KEYWORDS) {
      if (f.toLowerCase().includes(kw)) changedDomains.add(kw);
    }
  }

  for (const specSubdir of ["active", "implemented"]) {
    const specDir = join(repoRoot, "smartdocs", "specs", specSubdir);
    if (!existsSync(specDir)) continue;
    for (const f of readdirSync(specDir)) {
      if (!f.endsWith(".md") || basename(f).toLowerCase() === "summary.md") continue;
      const lower = f.toLowerCase();
      const matches = changedDomains.size === 0 || Array.from(changedDomains).some((kw) => lower.includes(kw));
      if (matches) canon.add(join(specDir, f));
    }
  }

  return canon;
}

/** Extract bullet-point lines from a named markdown section */
function extractSection(content: string, sectionHeader: string): string[] {
  const lines = content.split("\n");
  const result: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith("##") && line.toLowerCase().includes(sectionHeader.toLowerCase())) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (line.startsWith("##")) break; // next section
      const trimmed = line.trim();
      if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        result.push(trimmed.replace(/^[-*]\s*/, ""));
      }
    }
  }
  return result;
}

/**
 * Check if a POLARIS.md rule explicitly names a changed file as deleted/removed while it still exists.
 * This is the primary `stale-implementation` trigger for MVP.
 */
function checkPolarisMd(
  canonFile: string,
  changedFiles: string[],
  repoRoot: string,
): CanonConflict[] {
  const conflicts: CanonConflict[] = [];
  let content: string;
  try {
    content = readFileSync(canonFile, "utf-8");
  } catch {
    return conflicts;
  }

  const editingRules = extractSection(content, "editing rules");
  const archAssumptions = extractSection(content, "architecture assumptions");
  const allRules = [...editingRules, ...archAssumptions];

  for (const rule of allRules) {
    const lower = rule.toLowerCase();
    // Detect rules that say something is deleted/removed but the file still exists
    const isDeleted = /\b(deleted|removed|no longer exists|do not use)\b/.test(lower);
    if (!isDeleted) continue;

    for (const changedFile of changedFiles) {
      const fileBasename = basename(changedFile);
      if (lower.includes(fileBasename.toLowerCase()) && existsSync(resolve(repoRoot, changedFile))) {
        // Determine conflict type based on rule text and changed file
        let conflictType: Exclude<CanonOutcome, "aligned"> = "stale-implementation";
        const ext = changedFile.split(".").pop()?.toLowerCase() ?? "";
        const isDocFile = ext === "md" || changedFile.startsWith("smartdocs/");
        const hasDocKeywords = /\b(doc|documentation|readme|guide|spec)\b/i.test(lower);
        const hasCandidateKeywords = /\b(candidate|divergence|proposal)\b/i.test(lower);

        if (isDocFile || hasDocKeywords) {
          conflictType = "stale-docs";
        } else if (hasCandidateKeywords) {
          conflictType = "candidate-divergence";
        }

        conflicts.push({
          type: conflictType,
          canonFile,
          statement: rule,
          changedFile,
          detail: `POLARIS.md states "${fileBasename}" is deleted/removed but the file still exists`,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Check doctrine/spec files for modal-verb assertions that directly contradict changed files.
 * MVP: only flag stale-implementation when a named file/command is explicitly asserted to
 * exist/be-required but is missing, or asserted as deleted while still present.
 */
function checkDocFile(
  canonFile: string,
  changedFiles: string[],
  repoRoot: string,
): CanonConflict[] {
  if (basename(canonFile).toLowerCase() === "summary.md") return [];
  const conflicts: CanonConflict[] = [];
  let content: string;
  try {
    content = readFileSync(canonFile, "utf-8");
  } catch {
    return conflicts;
  }

  const lines = content.split("\n");

  for (const line of lines) {
    if (!MODAL_VERBS.test(line)) continue;
    const lower = line.toLowerCase();

    // Only flag lines that name a specific file/command that should exist but doesn't
    const deletedAssertion = /\b(deleted|removed|no longer exists)\b/.test(lower);
    if (!deletedAssertion) continue;

    for (const changedFile of changedFiles) {
      const fileBasename = basename(changedFile);
      if (lower.includes(fileBasename.toLowerCase()) && existsSync(resolve(repoRoot, changedFile))) {
        conflicts.push({
          type: "stale-implementation",
          canonFile,
          statement: line.trim(),
          changedFile,
          detail: `Canon asserts "${fileBasename}" is deleted/removed but file still exists`,
        });
      }
    }
  }

  return conflicts;
}

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(telemetryFile), { recursive: true });
    appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // Non-fatal: telemetry write failure should not block operation
  }
}

/**
 * Run the canon reconciliation check.
 *
 * Emits `canon-check-start` and either `canon-check-result` or `canon-conflict-halt`
 * to the telemetry file. Returns the result for the caller to act on.
 *
 * Note: This function does NOT call process.exit. Callers are responsible for
 * halting execution based on the returned outcome.
 */
export function runCanonCheck(options: CanonCheckOptions): CanonCheckResult {
  const { repoRoot, changedFiles, childId, runId, telemetryFile } = options;

  const canonFilesSet = locateCanonFiles(changedFiles, repoRoot);
  const canonFilesInspected = canonFilesSet.size;

  appendTelemetry(telemetryFile, {
    event: "canon-check-start",
    run_id: runId,
    child_id: childId ?? null,
    canon_files_inspected: canonFilesInspected,
    changed_files_count: changedFiles.length,
    timestamp: new Date().toISOString(),
  });

  if (canonFilesInspected === 0 || changedFiles.length === 0) {
    const result: CanonCheckResult = { outcome: "aligned", conflicts: [], canonFilesInspected };
    appendTelemetry(telemetryFile, {
      event: "canon-check-result",
      run_id: runId,
      child_id: childId ?? null,
      outcome: "aligned",
      conflicts: [],
      timestamp: new Date().toISOString(),
    });
    return result;
  }

  const allConflicts: CanonConflict[] = [];

  for (const canonFile of canonFilesSet) {
    const fileBasename = basename(canonFile);
    const isPolarisMd = fileBasename === "POLARIS.md";
    const fileConflicts = isPolarisMd
      ? checkPolarisMd(canonFile, changedFiles, repoRoot)
      : checkDocFile(canonFile, changedFiles, repoRoot);
    allConflicts.push(...fileConflicts);
  }

  // Classify outcome: stale-implementation wins; then stale-docs; then candidate-divergence; else aligned
  let outcome: CanonOutcome = "aligned";
  if (allConflicts.some((c) => c.type === "stale-implementation")) {
    outcome = "stale-implementation";
  } else if (allConflicts.some((c) => c.type === "stale-docs")) {
    outcome = "stale-docs";
  } else if (allConflicts.some((c) => c.type === "candidate-divergence")) {
    outcome = "candidate-divergence";
  }

  const result: CanonCheckResult = { outcome, conflicts: allConflicts, canonFilesInspected };

  if (outcome === "stale-implementation") {
    const first = allConflicts.find((c) => c.type === "stale-implementation")!;
    appendTelemetry(telemetryFile, {
      event: "canon-conflict-halt",
      run_id: runId,
      child_id: childId ?? null,
      reason: first.detail,
      canon_file: first.canonFile,
      conflicting_statement: first.statement,
      missing_or_differing: first.changedFile,
      suggested_resolution: "Update the canon file to reflect current state, or remove/fix the conflicting assertion",
      timestamp: new Date().toISOString(),
    });
  } else {
    appendTelemetry(telemetryFile, {
      event: "canon-check-result",
      run_id: runId,
      child_id: childId ?? null,
      outcome,
      conflicts: allConflicts,
      timestamp: new Date().toISOString(),
    });
  }

  // For non-blocking outcomes, write draft docs as specified
  if (outcome === "stale-docs") {
    writeStaleDraftDocs(allConflicts.filter((c) => c.type === "stale-docs"), repoRoot, childId);
  } else if (outcome === "candidate-divergence") {
    writeCandidateDraftDocs(allConflicts.filter((c) => c.type === "candidate-divergence"), repoRoot, childId);
  }

  return result;
}

function writeStaleDraftDocs(conflicts: CanonConflict[], repoRoot: string, childId?: string): void {
  const rawDir = join(repoRoot, "smartdocs", "raw");
  try {
    mkdirSync(rawDir, { recursive: true });
    for (const conflict of conflicts) {
      const slug = basename(conflict.canonFile).replace(/\.md$/, "");
      const date = new Date().toISOString().slice(0, 10);
      const filename = `stale-flag-${slug}-${date}.md`;
      const path = join(rawDir, filename);
      if (!existsSync(path)) {
        writeFileSync(path, [
          `# Stale Doc Flag`,
          ``,
          `**Canon file:** ${conflict.canonFile}`,
          `**Triggering file:** ${conflict.changedFile}`,
          `**What appears outdated:** ${conflict.statement}`,
          `**Detail:** ${conflict.detail}`,
          `**Flagged by:** ${childId ?? "finalize"}`,
          `**Date:** ${new Date().toISOString()}`,
        ].join("\n"), "utf-8");
      }
    }
  } catch {
    // Non-fatal
  }
}

function writeCandidateDraftDocs(conflicts: CanonConflict[], repoRoot: string, childId?: string): void {
  const candidateDir = join(repoRoot, "smartdocs", "doctrine", "candidate");
  try {
    mkdirSync(candidateDir, { recursive: true });
    for (const conflict of conflicts) {
      const slug = basename(conflict.canonFile).replace(/\.md$/, "");
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${slug}-${date}.draft.md`;
      const path = join(candidateDir, filename);
      if (!existsSync(path)) {
        writeFileSync(path, [
          `---`,
          `status: candidate`,
          `source: ${conflict.canonFile}`,
          `proposed-by: ${childId ?? "unknown"}`,
          `proposed-at: ${new Date().toISOString()}`,
          `---`,
          ``,
          `# Candidate Divergence Draft`,
          ``,
          `**Source canon file:** ${conflict.canonFile}`,
          `**Conflicting statement:** ${conflict.statement}`,
          `**Changed file:** ${conflict.changedFile}`,
          `**Detail:** ${conflict.detail}`,
        ].join("\n"), "utf-8");
      }
    }
  } catch {
    // Non-fatal
  }
}

// ── SmartDocs two-tier link staleness check ───────────────────────────────────

export interface SmartDocsLinkCheckOptions {
  repoRoot: string;
  runId: string;
  telemetryFile: string;
  childId?: string;
}

export interface SmartDocsLinkCheckResult {
  conflicts: SpecConflict[];
  filesChecked: number;
}

/** Subdirectories of smartdocs/ that are subject to strict link checking */
const STRICT_SMARTDOCS_DIRS = [
  join("smartdocs", "doctrine", "candidate"),
  join("smartdocs", "doctrine", "active"),
  join("smartdocs", "specs", "candidate"),
  join("smartdocs", "specs", "active"),
];

/**
 * Recursively walk a directory and return all .md file paths.
 *
 * @param dir - Directory to walk
 * @returns Array of absolute paths to all .md files found recursively
 */
function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Walk the strict-tier smartdocs directories (candidate/ and active/ under doctrine/ and specs/)
 * and check every .md file for broken cross-links into smartdocs/.
 *
 * Recursively traverses subdirectories to find nested documents.
 * Files in raw/ are never checked (OKF §5.3 permissive default).
 * Broken links are reported as SpecConflict entries with type "stale-assumption".
 *
 * @param options - Options including repoRoot, runId, and telemetryFile
 * @returns Object with all detected conflicts and the count of files checked
 */
export function runSmartDocsLinkCheck(options: SmartDocsLinkCheckOptions): SmartDocsLinkCheckResult {
  const { repoRoot, runId, telemetryFile, childId } = options;
  const root = resolve(repoRoot);
  const allConflicts: SpecConflict[] = [];
  let filesChecked = 0;

  for (const subdir of STRICT_SMARTDOCS_DIRS) {
    const dir = join(root, subdir);
    if (!existsSync(dir)) continue;
    const markdownFiles = walkMarkdownFiles(dir);
    for (const filePath of markdownFiles) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      filesChecked++;
      const conflicts = checkSmartDocsLinks(filePath, content, root);
      allConflicts.push(...conflicts);
    }
  }

  appendTelemetry(telemetryFile, {
    event: "smartdocs-link-check-result",
    run_id: runId,
    child_id: childId ?? null,
    files_checked: filesChecked,
    broken_links: allConflicts.length,
    conflicts: allConflicts,
    timestamp: new Date().toISOString(),
  });

  return { conflicts: allConflicts, filesChecked };
}
