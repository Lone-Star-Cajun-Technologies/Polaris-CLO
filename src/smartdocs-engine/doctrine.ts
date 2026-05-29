import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";

export const CANDIDATE_MARKER = "<!-- polaris:doctrine-candidate -->";

export interface DoctrineOptions {
  repoRoot: string;
  runId?: string;
}

export interface DoctrineResult {
  source: string;
  destination: string;
  runId: string;
  lifecyclePath: string;
}

function generateRunId(): string {
  return `polaris-doctrine-${new Date().toISOString().slice(0, 10)}-001`;
}

function lifecycleFilePath(repoRoot: string, runId: string): string {
  return join(repoRoot, ".taskchain_artifacts", "polaris-doctrine", runId, "lifecycle.jsonl");
}

function auditFilePath(repoRoot: string, runId: string): string {
  return join(repoRoot, ".taskchain_artifacts", "polaris-doctrine", runId, "audit.jsonl");
}

/**
 * Parse a YAML-style front matter block from a markdown file.
 * Returns a map of key → raw string value (unquoted).
 * Strips the CANDIDATE_MARKER line before parsing if present.
 */
function parseFrontMatter(content: string): Map<string, string> {
  const result = new Map<string, string>();
  // Normalize line endings to Unix style
  const normalized = content.replace(/\r\n/g, "\n");
  // Strip candidate marker line if it's at the start
  const stripped = normalized.startsWith(CANDIDATE_MARKER)
    ? normalized.slice(CANDIDATE_MARKER.length).replace(/^\n/, "")
    : normalized;
  if (!stripped.startsWith("---\n")) return result;
  const end = stripped.indexOf("\n---", 4);
  if (end === -1) return result;
  const lines = stripped.slice(4, end).split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    result.set(key, value);
  }
  return result;
}

/**
 * Add governance placeholder fields to a document's front matter.
 * If no front matter exists, one is created. Existing keys are not overwritten.
 */
export function addCandidateGovernanceMetadata(content: string, docType: string): string {
  const govDefaults: Record<string, string> = {
    "doc-type": docType,
    "confidence": "0.0",
    "recommended-action": "hold",
    "overlap-analysis": "pending",
  };

  // Normalize line endings to Unix style
  const normalized = content.replace(/\r\n/g, "\n");

  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end !== -1) {
      const frontMatter = normalized.slice(4, end);
      const afterFrontMatter = normalized.slice(end + 4);
      const lines = frontMatter.split("\n");
      const existingKeys = new Set(
        lines
          .filter((l) => l.includes(":"))
          .map((l) => l.slice(0, l.indexOf(":")).trim().toLowerCase()),
      );
      const additions: string[] = [];
      for (const [key, val] of Object.entries(govDefaults)) {
        if (!existingKeys.has(key)) additions.push(`${key}: ${val}`);
      }
      if (additions.length === 0) return normalized;
      return `---\n${frontMatter}\n${additions.join("\n")}\n---${afterFrontMatter}`;
    }
  }

  // No front matter — create one
  const fields = Object.entries(govDefaults)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fields}\n---\n\n${normalized}`;
}

function appendLifecycle(lifecyclePath: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(lifecyclePath), { recursive: true });
  appendFileSync(lifecyclePath, JSON.stringify(event) + "\n", "utf-8");
}

function resolvePath(path: string, repoRoot: string): string {
  if (path.startsWith("/")) return path;
  return join(resolve(repoRoot), path);
}

/** Move a doc from smartdocs/docs/raw/ to smartdocs/docs/doctrine/candidate/ */
export function doctrineDraft(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const rawDir = resolve(repoRoot, "smartdocs", "docs", "raw");
  const relToRaw = relative(rawDir, source);
  const isInRaw = !relToRaw.startsWith("..") && !relToRaw.startsWith("/");

  if (!isInRaw) {
    throw new Error(
      `doctrineDraft source must be in smartdocs/docs/raw/ — got: ${source}`,
    );
  }

  const candidateDir = join(repoRoot, "smartdocs", "docs", "doctrine", "candidate");
  mkdirSync(candidateDir, { recursive: true });

  const destination = join(candidateDir, basename(source));
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  const content = readFileSync(source, "utf-8");
  writeFileSync(destination, `${CANDIDATE_MARKER}\n${content}`, "utf-8");
  unlinkSync(source);

  const lifecyclePath = lifecycleFilePath(repoRoot, runId);
  appendLifecycle(lifecyclePath, {
    event: "doctrine-draft",
    run_id: runId,
    source,
    destination,
    timestamp: new Date().toISOString(),
  });

  return { source, destination, runId, lifecyclePath };
}

/** Move a doc from smartdocs/docs/doctrine/candidate/ to smartdocs/docs/doctrine/active/ */
export function doctrinePromote(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const candidateDir = resolve(repoRoot, "smartdocs", "docs", "doctrine", "candidate");
  const relToCandidate = relative(candidateDir, source);
  const isInCandidate = !relToCandidate.startsWith("..") && !relToCandidate.startsWith("/");

  if (!isInCandidate) {
    throw new Error(
      `doctrinePromote source must be in smartdocs/docs/doctrine/candidate/ — got: ${source}`,
    );
  }

  const content = readFileSync(source, "utf-8");
  if (!content.includes(CANDIDATE_MARKER)) {
    throw new Error(
      `File is not in candidate state (missing ${CANDIDATE_MARKER}): ${source}`,
    );
  }

  const lifecyclePath = lifecycleFilePath(repoRoot, runId);

  // Governance check
  const fm = parseFrontMatter(content);
  const requiredFields = ["doc-type", "confidence", "recommended-action", "overlap-analysis"];
  for (const field of requiredFields) {
    if (!fm.has(field)) {
      throw new Error(
        `doctrinePromote: missing required governance field "${field}" in ${source}`,
      );
    }
  }
  const recommendedAction = fm.get("recommended-action");
  if (recommendedAction !== "promote") {
    throw new Error(
      `doctrinePromote: recommended-action must be "promote" but got "${recommendedAction}" in ${source}`,
    );
  }

  const activeDir = join(repoRoot, "smartdocs", "docs", "doctrine", "active");
  mkdirSync(activeDir, { recursive: true });

  const destination = join(activeDir, basename(source));
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  const activeContent = content.replace(`${CANDIDATE_MARKER}\n`, "").replace(CANDIDATE_MARKER, "");
  writeFileSync(destination, activeContent, "utf-8");
  unlinkSync(source);

  // Move co-located provenance sidecar if present
  const provenanceSrc = source.replace(/\.md$/, ".provenance.json");
  if (existsSync(provenanceSrc)) {
    const provenanceDest = destination.replace(/\.md$/, ".provenance.json");
    renameSync(provenanceSrc, provenanceDest);
  }

  // Write audit record
  const auditPath = auditFilePath(repoRoot, runId);
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(
    auditPath,
    JSON.stringify({
      event: "doctrine-promoted",
      run_id: runId,
      source,
      destination,
      doc_type: fm.get("doc-type") ?? null,
      confidence: fm.has("confidence") ? parseFloat(fm.get("confidence")!) : null,
      recommended_action: fm.get("recommended-action") ?? null,
      overlap_analysis: fm.get("overlap-analysis") ?? null,
      promoted_by: "polaris-cli",
      timestamp: new Date().toISOString(),
    }) + "\n",
    "utf-8",
  );

  appendLifecycle(lifecyclePath, {
    event: "doctrine-promote",
    run_id: runId,
    source,
    destination,
    timestamp: new Date().toISOString(),
  });

  return { source, destination, runId, lifecyclePath };
}

/** Move a doc from smartdocs/docs/doctrine/active/ to smartdocs/docs/doctrine/deprecated/ */
export function doctrineDeprecate(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const activeDir = resolve(repoRoot, "smartdocs", "docs", "doctrine", "active");
  const relToActive = relative(activeDir, source);
  const isInActive = !relToActive.startsWith("..") && !relToActive.startsWith("/");

  if (!isInActive) {
    throw new Error(
      `doctrineDeprecate source must be in smartdocs/docs/doctrine/active/ — got: ${source}`,
    );
  }

  const deprecatedDir = join(repoRoot, "smartdocs", "docs", "doctrine", "deprecated");
  mkdirSync(deprecatedDir, { recursive: true });

  const destination = join(deprecatedDir, basename(source));
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  const content = readFileSync(source, "utf-8");
  const deprecatedAt = new Date().toISOString();
  const deprecatedContent =
    `<!-- polaris:doctrine-deprecated deprecatedAt="${deprecatedAt}" runId="${runId}" -->\n${content}`;
  writeFileSync(destination, deprecatedContent, "utf-8");
  unlinkSync(source);

  // Move co-located provenance sidecar if present
  const provenanceSrc = source.replace(/\.md$/, ".provenance.json");
  if (existsSync(provenanceSrc)) {
    const provenanceDest = destination.replace(/\.md$/, ".provenance.json");
    renameSync(provenanceSrc, provenanceDest);
  }

  const lifecyclePath = lifecycleFilePath(repoRoot, runId);
  appendLifecycle(lifecyclePath, {
    event: "doctrine-deprecate",
    run_id: runId,
    source,
    destination,
    deprecated_at: deprecatedAt,
    timestamp: deprecatedAt,
  });

  return { source, destination, runId, lifecyclePath };
}

// ── Spec verb-keyword conflict detection ──────────────────────────────────────

const MODAL_REQUIRES = /\b(?:must\s+always|always|must)\s+(\w+)/gi;
const MODAL_PROHIBITS = /\b(?:must\s+never|must\s+not|never)\s+(\w+)/gi;
const CONFLICT_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "been", "will", "when", "then",
  "also", "only", "into", "over", "such", "each", "more", "same", "used",
]);

function extractSpecKeywords(content: string, pattern: RegExp): Set<string> {
  const result = new Set<string>();
  const re = new RegExp(pattern.source, pattern.flags);
  for (const match of content.matchAll(re)) {
    const kw = match[1]?.toLowerCase();
    if (kw && kw.length >= 4 && !CONFLICT_STOPWORDS.has(kw)) result.add(kw);
  }
  return result;
}

export interface SpecConflict {
  type: "content" | "map";
  conflictingFile: string;
  detail: string;
}

export interface SpecPromoteOptions extends DoctrineOptions {
  approve?: boolean;
}

export interface SpecPromoteResult {
  source: string;
  destination: string;
  runId: string;
  lifecyclePath: string;
  conflicts: SpecConflict[];
  halted: boolean;
  report: string;
}

/** Promote a raw spec from smartdocs/docs/raw/ to smartdocs/docs/specs/active/.
 *
 * Gate:
 *  1. Content conflict check — verb-keyword overlap with existing active specs.
 *  2. Map conflict check — linkedMapArea already covered by an active spec.
 *  3. Halts with a report unless approve is true.
 */
export function specPromote(path: string, options: SpecPromoteOptions): SpecPromoteResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);
  const lifecyclePath = lifecycleFilePath(repoRoot, runId);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const rawDir = resolve(repoRoot, "smartdocs", "docs", "raw");
  const relToRaw = relative(rawDir, source);
  const isInRaw = !relToRaw.startsWith("..") && !relToRaw.startsWith("/");
  if (!isInRaw) {
    throw new Error(`specPromote source must be in smartdocs/docs/raw/ — got: ${source}`);
  }

  const content = readFileSync(source, "utf-8");
  const conflicts: SpecConflict[] = [];

  // 1. Content conflict check against specs/active/
  const activeSpecsDir = resolve(repoRoot, "smartdocs", "docs", "specs", "active");
  if (existsSync(activeSpecsDir)) {
    const activeFiles = readdirSync(activeSpecsDir).filter((f) => f.endsWith(".md"));
    const incomingRequires = extractSpecKeywords(content, MODAL_REQUIRES);
    const incomingProhibits = extractSpecKeywords(content, MODAL_PROHIBITS);
    for (const file of activeFiles) {
      let activeContent: string;
      try { activeContent = readFileSync(join(activeSpecsDir, file), "utf-8"); } catch { continue; }
      const activeRequires = extractSpecKeywords(activeContent, MODAL_REQUIRES);
      const activeProhibits = extractSpecKeywords(activeContent, MODAL_PROHIBITS);
      for (const kw of incomingProhibits) {
        if (activeRequires.has(kw)) {
          conflicts.push({ type: "content", conflictingFile: file, detail: `incoming doc prohibits "${kw}" but ${file} requires it` });
        }
      }
      for (const kw of incomingRequires) {
        if (activeProhibits.has(kw)) {
          conflicts.push({ type: "content", conflictingFile: file, detail: `incoming doc requires "${kw}" but ${file} prohibits it` });
        }
      }
    }
  }

  // 2. Map conflict check — linkedMapArea already has an active spec
  const provenanceSrcPath = source.replace(/\.md$/, ".provenance.json");
  let linkedMapArea: string | null = null;
  if (existsSync(provenanceSrcPath)) {
    try {
      const prov = JSON.parse(readFileSync(provenanceSrcPath, "utf-8"));
      linkedMapArea = prov.linkedMapArea ?? null;
    } catch { /* ignore */ }
  }
  if (linkedMapArea && existsSync(activeSpecsDir)) {
    const activeFiles = readdirSync(activeSpecsDir).filter((f) => f.endsWith(".md"));
    for (const file of activeFiles) {
      let activeContent: string;
      try { activeContent = readFileSync(join(activeSpecsDir, file), "utf-8"); } catch { continue; }
      if (activeContent.includes(linkedMapArea)) {
        conflicts.push({ type: "map", conflictingFile: file, detail: `linked map area "${linkedMapArea}" is already referenced by active spec ${file}` });
      }
    }
  }

  // 3. Build report
  const reportLines: string[] = [`spec-promote: ${basename(source)}`];
  if (conflicts.length === 0) {
    reportLines.push("  no content conflicts detected");
    reportLines.push("  no map area conflicts detected");
  } else {
    reportLines.push(`  ${conflicts.length} conflict(s) detected:`);
    for (const c of conflicts) {
      reportLines.push(`    [${c.type}] ${c.detail}`);
    }
    if (!options.approve) {
      reportLines.push("");
      reportLines.push("  Halted. Resolve conflicts or rerun with --approve to override.");
    }
  }
  const report = reportLines.join("\n");

  // 4. Halt if conflicts and not approved
  if (conflicts.length > 0 && !options.approve) {
    appendLifecycle(lifecyclePath, {
      event: "spec-promote-halted",
      run_id: runId,
      source,
      conflicts,
      timestamp: new Date().toISOString(),
    });
    return { source, destination: "", runId, lifecyclePath, conflicts, halted: true, report };
  }

  // 5. Promote
  const activeDir = join(repoRoot, "smartdocs", "docs", "specs", "active");
  mkdirSync(activeDir, { recursive: true });
  const destination = join(activeDir, basename(source));
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  renameSync(source, destination);

  if (existsSync(provenanceSrcPath)) {
    renameSync(provenanceSrcPath, destination.replace(/\.md$/, ".provenance.json"));
  }

  appendLifecycle(lifecyclePath, {
    event: "spec-promote",
    run_id: runId,
    source,
    destination,
    conflicts_at_promote: conflicts.length,
    approved: options.approve ?? false,
    timestamp: new Date().toISOString(),
  });

  return { source, destination, runId, lifecyclePath, conflicts, halted: false, report };
}
