import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

  const rawDir = join(repoRoot, "docs", "raw") + "/";
  const doctrineRawDir = join(repoRoot, "docs", "doctrine", "raw") + "/";
  if (!source.startsWith(rawDir) && !source.startsWith(doctrineRawDir)) {
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

  const candidateDir = join(repoRoot, "docs", "doctrine", "candidate") + "/";
  if (!source.startsWith(candidateDir)) {
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

  const activeDir = join(repoRoot, "docs", "doctrine", "active");
  mkdirSync(activeDir, { recursive: true });

  const destination = join(activeDir, basename(source));
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  const activeContent = content.replace(`${CANDIDATE_MARKER}\n`, "").replace(CANDIDATE_MARKER, "");
  writeFileSync(destination, activeContent, "utf-8");
  unlinkSync(source);

  const lifecyclePath = lifecycleFilePath(repoRoot, runId);
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

  const activeDir = join(repoRoot, "docs", "doctrine", "active") + "/";
  if (!source.startsWith(activeDir)) {
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
