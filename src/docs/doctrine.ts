import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";

export const CANDIDATE_MARKER = "<!-- polaris:doctrine-candidate -->";

export interface DoctrineOptions {
  repoRoot: string;
  runId?: string;
  skipGovernance?: boolean;
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
  // Strip candidate marker line if it's at the start
  const stripped = content.startsWith(CANDIDATE_MARKER)
    ? content.slice(CANDIDATE_MARKER.length).replace(/^\n/, "")
    : content;
  if (!stripped.startsWith("---\n")) return result;
  const end = stripped.indexOf("\n---", 4);
  if (end === -1) return result;
  const lines = stripped.slice(4, end).split(/\r?\n/);
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

  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const frontMatter = content.slice(4, end);
      const afterFrontMatter = content.slice(end + 4);
      const lines = frontMatter.split(/\r?\n/);
      const existingKeys = new Set(
        lines
          .filter((l) => l.includes(":"))
          .map((l) => l.slice(0, l.indexOf(":")).trim().toLowerCase()),
      );
      const additions: string[] = [];
      for (const [key, val] of Object.entries(govDefaults)) {
        if (!existingKeys.has(key)) additions.push(`${key}: ${val}`);
      }
      if (additions.length === 0) return content;
      return `---\n${frontMatter}\n${additions.join("\n")}\n---${afterFrontMatter}`;
    }
  }

  // No front matter — create one
  const fields = Object.entries(govDefaults)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fields}\n---\n\n${content}`;
}

function appendLifecycle(lifecyclePath: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(lifecyclePath), { recursive: true });
  appendFileSync(lifecyclePath, JSON.stringify(event) + "\n", "utf-8");
}

function resolvePath(path: string, repoRoot: string): string {
  if (path.startsWith("/")) return path;
  return join(resolve(repoRoot), path);
}

/** Move a doc from docs/raw/ or docs/doctrine/raw/ to docs/doctrine/candidate/ */
export function doctrineDraft(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const rawDir = resolve(repoRoot, "docs", "raw");
  const doctrineRawDir = resolve(repoRoot, "docs", "doctrine", "raw");
  const relToRaw = relative(rawDir, source);
  const relToDoctrineRaw = relative(doctrineRawDir, source);
  const isInRaw = !relToRaw.startsWith("..") && !relToRaw.startsWith("/");
  const isInDoctrineRaw = !relToDoctrineRaw.startsWith("..") && !relToDoctrineRaw.startsWith("/");

  if (!isInRaw && !isInDoctrineRaw) {
    throw new Error(
      `doctrineDraft source must be in docs/raw/ or docs/doctrine/raw/ — got: ${source}`,
    );
  }

  const candidateDir = join(repoRoot, "docs", "doctrine", "candidate");
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

/** Move a doc from docs/doctrine/candidate/ to docs/doctrine/active/ */
export function doctrinePromote(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const candidateDir = resolve(repoRoot, "docs", "doctrine", "candidate");
  const relToCandidate = relative(candidateDir, source);
  const isInCandidate = !relToCandidate.startsWith("..") && !relToCandidate.startsWith("/");

  if (!isInCandidate) {
    throw new Error(
      `doctrinePromote source must be in docs/doctrine/candidate/ — got: ${source}`,
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
  if (options.skipGovernance) {
    appendLifecycle(lifecyclePath, {
      event: "governance-override",
      run_id: runId,
      source,
      timestamp: new Date().toISOString(),
    });
  } else {
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
  }

  const activeDir = join(repoRoot, "docs", "doctrine", "active");
  mkdirSync(activeDir, { recursive: true });

  const destination = join(activeDir, basename(source));
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  const activeContent = content.replace(`${CANDIDATE_MARKER}\n`, "").replace(CANDIDATE_MARKER, "");
  writeFileSync(destination, activeContent, "utf-8");
  unlinkSync(source);

  // Write audit record
  const fm = parseFrontMatter(content);
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

/** Move a doc from docs/doctrine/active/ to docs/doctrine/deprecated/ */
export function doctrineDeprecate(path: string, options: DoctrineOptions): DoctrineResult {
  const repoRoot = resolve(options.repoRoot);
  const runId = options.runId ?? generateRunId();
  const source = resolvePath(path, repoRoot);

  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const activeDir = resolve(repoRoot, "docs", "doctrine", "active");
  const relToActive = relative(activeDir, source);
  const isInActive = !relToActive.startsWith("..") && !relToActive.startsWith("/");

  if (!isInActive) {
    throw new Error(
      `doctrineDeprecate source must be in docs/doctrine/active/ — got: ${source}`,
    );
  }

  const deprecatedDir = join(repoRoot, "docs", "doctrine", "deprecated");
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
