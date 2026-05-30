import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isIngestIneligible } from "./smartdoc-ignore.js";

export interface MigrateOptions {
  repoRoot: string;
  dryRun?: boolean;
  migrationRunId?: string;
}

export interface MigrateFileResult {
  originalPath: string;
  currentPath: string;
  classification: "allowed-exception" | "migrated";
  exceptionReason?: string;
  endpointArtifactReason?: string;
  destination?: string;
}

export interface MigrateResult {
  results: MigrateFileResult[];
  migrationRunId: string;
  provenancePath: string | null;
  ingestBatches: string[][];
  dryRun: boolean;
}

/** Basenames that are always allowed regardless of location. */
const ALLOWED_BASENAMES = new Set([
  "README.md",
  "POLARIS.md",
  "CHANGELOG.md",
  "LICENSE.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "COPILOT.md",
]);

/**
 * Directory prefixes (relative to repo root, forward-slash notation) where
 * markdown files may live without being migrated.
 */
const ALLOWED_DIR_PREFIXES = [
  ".agents/",
  ".codex/",
  ".claude/",
  ".gemini/",
  ".github/",
  ".polaris/",
  ".taskchain_artifacts/",
  "generated/",
  "summaries/",
  "smartdocs/",
];

export function isAllowedException(
  relPath: string,
  repoRoot?: string,
): { allowed: boolean; reason?: string; endpointArtifactReason?: string } {
  const name = basename(relPath);

  if (ALLOWED_BASENAMES.has(name)) {
    return { allowed: true, reason: `allowed basename: ${name}` };
  }

  for (const prefix of ALLOWED_DIR_PREFIXES) {
    if (relPath.startsWith(prefix)) {
      return { allowed: true, reason: `in allowed directory: ${prefix}` };
    }
  }

  if (repoRoot) {
    const eligibility = isIngestIneligible(relPath, repoRoot);
    if (eligibility.ineligible) {
      return {
        allowed: true,
        reason: eligibility.reason,
        endpointArtifactReason: "smartdocignore-endpoint-artifact",
      };
    }
  }

  return { allowed: false };
}

function findMarkdownFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.endsWith(".md"));
  } catch {
    // Fallback if not a git repo: use find
    const output = execFileSync(
      "find",
      [".", "-name", "*.md", "-not", "-path", "./.git/*"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    return output
      .split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter((l) => l.length > 0 && l.endsWith(".md"));
  }
}

function uniqueDestination(filePath: string): string {
  if (!existsSync(filePath)) return filePath;
  const dir = dirname(filePath);
  const name = basename(filePath, ".md");
  let index = 2;
  let candidate = join(dir, `${name}-${index}.md`);
  while (existsSync(candidate)) {
    index += 1;
    candidate = join(dir, `${name}-${index}.md`);
  }
  return candidate;
}

function makeMigrationRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const seq = String(Date.now()).slice(-4);
  return `polaris-docs-migrate-${date}-${seq}`;
}

function batchFiles(files: string[], batchSize = 4): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }
  return batches;
}

export function migrateDocs(options: MigrateOptions): MigrateResult {
  const repoRoot = resolve(options.repoRoot);
  const migrationRunId = options.migrationRunId ?? makeMigrationRunId();
  const rawDir = resolve(repoRoot, "smartdocs/raw");

  const allMd = findMarkdownFiles(repoRoot);
  const results: MigrateFileResult[] = [];
  const toMigrate: string[] = [];

  for (const relPath of allMd) {
    const check = isAllowedException(relPath, repoRoot);
    if (check.allowed) {
      results.push({
        originalPath: relPath,
        currentPath: relPath,
        classification: "allowed-exception",
        exceptionReason: check.reason,
        endpointArtifactReason: check.endpointArtifactReason,
      });
    } else {
      toMigrate.push(relPath);
    }
  }

  if (!options.dryRun && toMigrate.length > 0) {
    mkdirSync(rawDir, { recursive: true });
  }

  const provenanceRecords: Array<{
    originalPath: string;
    currentPath: string;
    migratedAt: string;
    migrationRunId: string;
  }> = [];

  for (const relPath of toMigrate) {
    const absSource = resolve(repoRoot, relPath);
    const destFile = uniqueDestination(join(rawDir, basename(relPath)));
    const relDest = relative(repoRoot, destFile).replace(/\\/g, "/");

    if (!options.dryRun) {
      mkdirSync(dirname(destFile), { recursive: true });
      renameSync(absSource, destFile);
      provenanceRecords.push({
        originalPath: relPath,
        currentPath: relDest,
        migratedAt: new Date().toISOString(),
        migrationRunId,
      });
    }

    results.push({
      originalPath: relPath,
      currentPath: options.dryRun ? relPath : relDest,
      classification: "migrated",
      destination: relDest,
    });
  }

  let provenancePath: string | null = null;

  if (!options.dryRun && provenanceRecords.length > 0) {
    const provDir = resolve(
      repoRoot,
      ".taskchain_artifacts",
      "polaris-docs-migrate",
      migrationRunId,
    );
    mkdirSync(provDir, { recursive: true });
    const absProvPath = join(provDir, "provenance.json");
    writeFileSync(
      absProvPath,
      JSON.stringify(provenanceRecords, null, 2) + "\n",
      "utf-8",
    );
    provenancePath = relative(repoRoot, absProvPath).replace(/\\/g, "/");
  }

  // Build ingest batch paths: where files will land in smartdocs/raw/
  const migratedDestPaths: string[] = results
    .filter((r) => r.classification === "migrated")
    .map((r) => r.destination ?? `smartdocs/raw/${basename(r.originalPath)}`);

  const ingestBatches = batchFiles(migratedDestPaths, 4);

  return { results, migrationRunId, provenancePath, ingestBatches, dryRun: Boolean(options.dryRun) };
}

export function printMigrateResults(result: MigrateResult): void {
  const prefix = result.dryRun ? "[dry-run] " : "";
  const migrated = result.results.filter((r) => r.classification === "migrated");
  const exceptions = result.results.filter((r) => r.classification === "allowed-exception");

  console.log(`\n${prefix}Migration run: ${result.migrationRunId}`);
  console.log(`${prefix}Files to migrate: ${migrated.length}`);

  for (const r of migrated) {
    const dest = r.destination ?? `raw/${basename(r.originalPath)}`;
    console.log(`  ${r.originalPath} -> ${dest}`);
  }

  if (exceptions.length > 0) {
    console.log(`\n${prefix}Allowed exceptions (not moved): ${exceptions.length}`);
    for (const r of exceptions) {
      console.log(`  ${r.originalPath}  [${r.exceptionReason}]`);
    }
  }

  if (result.ingestBatches.length > 0) {
    console.log(
      `\n${prefix}Ingest cluster batches (${result.ingestBatches.length} batch${result.ingestBatches.length === 1 ? "" : "es"}):`,
    );
    result.ingestBatches.forEach((batch, i) => {
      console.log(`  Batch ${i + 1}:`);
      for (const f of batch) {
        console.log(`    polaris docs ingest --file ${f}`);
      }
    });
  }

  if (result.provenancePath) {
    console.log(`\nProvenance written to: ${result.provenancePath}`);
  }
}
