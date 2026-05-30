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

/**
 * Builds the filesystem path to the audit JSONL file for a given doctrine run.
 *
 * @param repoRoot - The repository root directory
 * @param runId - The doctrine run identifier
 * @returns The full path to `.taskchain_artifacts/polaris-doctrine/<runId>/audit.jsonl`
 */
function auditFilePath(repoRoot: string, runId: string): string {
  return join(repoRoot, ".taskchain_artifacts", "polaris-doctrine", runId, "audit.jsonl");
}

/**
 * Canonical frontmatter schema for SmartDocs.
 *
 * Identity fields identify the document itself.
 * Governance fields control the doctrine/spec promotion lifecycle.
 * Relationship fields link this document to source code and sibling docs.
 */
export interface ParsedFrontMatter {
  // Identity
  id?: string;
  kind?: string;
  status?: string;
  owner?: string;
  source?: string;
  created?: string;
  updated?: string;
  // Governance (existing)
  "doc-type"?: string;
  confidence?: string;
  "recommended-action"?: string;
  "overlap-analysis"?: string;
  "candidate-since"?: string;
  // Relationships (new)
  implements?: string;
  related?: string;
  supersedes?: string;
  superseded_by?: string;
  depends_on?: string;
  validates?: string;
  /**
   * Comma-separated list of source file paths this document describes.
   * When these files are touched, SUMMARY.md delta signals are enriched.
   */
  source_paths?: string;
  // Index signature allows arbitrary frontmatter keys
  [key: string]: string | undefined;
}

/**
 * Parse YAML-style frontmatter from a Markdown string into a map of raw key/value pairs.
 *
 * Normalizes CRLF to LF and tolerates a leading candidate marker line. If a frontmatter
 * block delimited by `---` is found, each line inside the block is split at the first
 * `:`; keys are lowercased and trimmed, values are trimmed and stripped of surrounding
 * single/double quotes. If no well-formed frontmatter is present, an empty map is returned.
 *
 * @param content - The raw file content to inspect for a frontmatter block.
 * @returns A Map where each entry is `key -> value` from the frontmatter; keys are lowercased and values are trimmed with surrounding quotes removed.
function parseFrontMatterRaw(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const normalized = content.replace(/\r\n/g, "\n");
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
 * Extracts YAML-style front matter from markdown content into a ParsedFrontMatter object.
 *
 * Strips a leading candidate marker line if present and parses key:value pairs from a YAML-style block delimited by `---`.
 *
 * @param content - Markdown file content to parse
 * @returns The parsed front matter as a ParsedFrontMatter object where keys are front-matter fields and values are their string values
 */
export function parseFrontMatter(content: string): ParsedFrontMatter {
  const raw = parseFrontMatterRaw(content);
  const result: ParsedFrontMatter = {};
  for (const [key, value] of raw) {
    result[key] = value;
  }
  return result;
}

/**
 * Ensure a candidate governance frontmatter block exists and add placeholder governance and relationship fields without overwriting existing keys.
 *
 * Normalizes CRLF to LF. If a YAML-style frontmatter block is present it appends any missing governance keys; if no frontmatter exists it prepends a new block containing the default governance and relationship scaffold. Existing frontmatter keys and their values are preserved.
 *
 * @param content - The markdown document content to update
 * @param docType - The value to use for the `doc-type` field in the frontmatter
 * @returns The markdown content with governance placeholder frontmatter added or updated
 */
export function addCandidateGovernanceMetadata(content: string, docType: string): string {
  const govDefaults: Record<string, string> = {
    "doc-type": docType,
    "confidence": "0.0",
    "recommended-action": "hold",
    "overlap-analysis": "pending",
    // Relationship scaffolding — populated by author before promotion
    "implements": "",
    "related": "",
    "supersedes": "",
    "superseded_by": "",
    "depends_on": "",
    "validates": "",
    "source_paths": "",
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

/**
 * Resolve a filesystem path against a repository root and return an absolute path.
 *
 * @param path - The input path to resolve; may be absolute or relative.
 * @param repoRoot - The repository root used to resolve relative paths.
 * @returns An absolute filesystem path. If `path` starts with `/` it is returned unchanged; otherwise the result of resolving `path` against `repoRoot`.
 */
function resolvePath(path: string, repoRoot: string): string {
  if (path.startsWith("/")) return path;
  return join(resolve(repoRoot), path);
}

/**
 * Move a markdown file from the repository's smartdocs/raw/ directory into smartdocs/doctrine/candidate/,
 * mark it as a doctrine candidate, delete the original, and append a lifecycle event.
 *
 * @param path - Path to the source file; if not absolute, it is resolved relative to `options.repoRoot`
 * @param options - Operation options; `options.repoRoot` specifies the repository root and `options.runId` may override the generated run id
 * @returns An object containing `source` (resolved source path), `destination` (path in the candidate directory), `runId` (the run identifier used), and `lifecyclePath` (path to the lifecycle log file)
 */
export function doctrineDraft(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const rawDir = resolve(repoRoot, "smartdocs", "raw");
  const relToRaw = relative(rawDir, source);
  const isInRaw = !relToRaw.startsWith("..") && !relToRaw.startsWith("/");

  if (!isInRaw) {
    throw new Error(
      `doctrineDraft source must be in smartdocs/raw/ — got: ${source}`,
    );
  }

  const candidateDir = join(repoRoot, "smartdocs", "doctrine", "candidate");
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

/**
 * Promote a candidate SmartDoc into the doctrine active pool.
 *
 * Moves a Markdown file from smartdocs/doctrine/candidate/ to smartdocs/doctrine/active/,
 * removes the candidate marker, preserves a provenance sidecar if present, records an audit
 * entry, and appends a lifecycle event.
 *
 * @param path - Path to the candidate Markdown file (absolute or repository-relative)
 * @param options - Doctrine operation options (must include `repoRoot`; may include `runId`)
 * @returns The operation result containing `source`, `destination`, `runId`, and `lifecyclePath`
 * @throws If the source file does not exist
 * @throws If the source is not located under smartdocs/doctrine/candidate/
 * @throws If the file does not contain the candidate marker
 * @throws If required governance frontmatter fields are missing
 * @throws If `recommended-action` in frontmatter is not `"promote"`
 * @throws If the destination file already exists
 */
export function doctrinePromote(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const candidateDir = resolve(repoRoot, "smartdocs", "doctrine", "candidate");
  const relToCandidate = relative(candidateDir, source);
  const isInCandidate = !relToCandidate.startsWith("..") && !relToCandidate.startsWith("/");

  if (!isInCandidate) {
    throw new Error(
      `doctrinePromote source must be in smartdocs/doctrine/candidate/ — got: ${source}`,
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
  const fm = parseFrontMatterRaw(content);
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

  const activeDir = join(repoRoot, "smartdocs", "doctrine", "active");
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

/**
 * Move a doctrine document from smartdocs/doctrine/active/ into smartdocs/doctrine/deprecated/ and record the deprecation event.
 *
 * @param path - Absolute or repository-relative path to the source markdown file; must be located in smartdocs/doctrine/active/.
 * @param options - Options object containing `repoRoot` (repository root used to resolve relative paths) and an optional `runId`.
 * @returns An object with `source` (original path), `destination` (new path under deprecated), `runId` used for this operation, and `lifecyclePath` where the lifecycle event was appended.
 * @throws Error if the source file does not exist, if the source is not inside smartdocs/doctrine/active/, or if the destination file already exists.
 */
export function doctrineDeprecate(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const activeDir = resolve(repoRoot, "smartdocs", "doctrine", "active");
  const relToActive = relative(activeDir, source);
  const isInActive = !relToActive.startsWith("..") && !relToActive.startsWith("/");

  if (!isInActive) {
    throw new Error(
      `doctrineDeprecate source must be in smartdocs/doctrine/active/ — got: ${source}`,
    );
  }

  const deprecatedDir = join(repoRoot, "smartdocs", "doctrine", "deprecated");
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

/**
 * Promotes a spec file from smartdocs/raw/ into smartdocs/specs/active/.
 *
 * Performs two pre-promotion checks: content conflicts against existing active specs
 * (verb-keyword requirements vs prohibitions) and map-area conflicts based on a
 * provenance `linkedMapArea`. If conflicts are found the operation halts and returns
 * a human-readable report unless approval is explicitly provided.
 *
 * @param path - Filesystem path to the source `.md` spec (must reside under `smartdocs/raw/`)
 * @param options - Promotion options and environment:
 *   - `repoRoot`: repository root directory
 *   - `approve`: when true, proceed with promotion despite detected conflicts
 *   - `runId`: optional run identifier to use for lifecycle/audit paths
 * @returns The promotion result containing:
 *   - `source`: original source path
 *   - `destination`: destination path under `smartdocs/specs/active/` (empty string if halted)
 *   - `runId`: run identifier used
 *   - `lifecyclePath`: path to the lifecycle log for this run
 *   - `conflicts`: array of detected `SpecConflict` entries
 *   - `halted`: `true` if promotion was stopped due to conflicts and `approve` was not set
 *   - `report`: multi-line text report summarizing detected conflicts and action taken
 */
export function specPromote(path: string, options: SpecPromoteOptions): SpecPromoteResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);
  const lifecyclePath = lifecycleFilePath(repoRoot, runId);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const rawDir = resolve(repoRoot, "smartdocs", "raw");
  const relToRaw = relative(rawDir, source);
  const isInRaw = !relToRaw.startsWith("..") && !relToRaw.startsWith("/");
  if (!isInRaw) {
    throw new Error(`specPromote source must be in smartdocs/raw/ — got: ${source}`);
  }

  const content = readFileSync(source, "utf-8");
  const conflicts: SpecConflict[] = [];

  // 1. Content conflict check against specs/active/
  const activeSpecsDir = resolve(repoRoot, "smartdocs", "specs", "active");
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
  const activeDir = join(repoRoot, "smartdocs", "specs", "active");
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
