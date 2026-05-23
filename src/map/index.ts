import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { runMapUpdate } from "./update.js";
import { runMapValidate } from "./validate.js";
import { runMapQuery } from "./query.js";
import { parsePolarisIgnore } from "../ignore/parser.js";
import { SECRET_PATTERNS } from "../ignore/defaults.js";
import { inferRoute } from "./inference.js";
import {
  readFileRoutes,
  readExemptions,
  writeFileRoutes,
  writeNeedsReview,
  writeExemptions,
  writeAtlasIndex,
  type FileRouteEntry,
} from "./atlas.js";

const SECRET_REGEXES = SECRET_PATTERNS.map(
  (p) => new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"),
);

function isSecretFile(filePath: string): boolean {
  const parts = filePath.split("/");
  const base = parts[parts.length - 1]!;
  return SECRET_REGEXES.some((re) => re.test(base) || re.test(filePath));
}

function* walkDir(dir: string, root: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      yield* walkDir(full, root);
    } else {
      yield rel;
    }
  }
}

function getBranchName(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function loadIgnoreFilter(repoRoot: string): ReturnType<typeof parsePolarisIgnore> {
  let userPatterns: string[] = [];
  try {
    const raw = readFileSync(resolve(repoRoot, ".polarisignore"), "utf-8");
    userPatterns = raw.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("#"));
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code !== "ENOENT") {
      throw err;
    }
  }
  return parsePolarisIgnore(userPatterns);
}

export function runMapIndex(repoRoot: string, dryRun: boolean, verbose: boolean): void {
  const config = loadConfig(repoRoot);
  const outputPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const branchName = getBranchName(repoRoot);
  const ig = loadIgnoreFilter(repoRoot);

  const existingRoutes = readFileRoutes(outputPath);
  const existingExemptions = readExemptions(outputPath);

  const newRoutes: Record<string, FileRouteEntry> = {};
  const newNeedsReview: Record<string, FileRouteEntry> = {};
  const newExemptions = { ...existingExemptions };

  let scanned = 0;
  let mapped = 0;
  let trackedNotIndexed = 0;
  let needsReview = 0;
  let ignored = 0;

  const now = new Date().toISOString();

  if (!existsSync(repoRoot)) {
    console.error(`Repo root not found: ${repoRoot}`);
    process.exit(1);
  }

  for (const filePath of walkDir(repoRoot, repoRoot)) {
    scanned++;

    // Security check — never process secret files
    if (isSecretFile(filePath)) {
      console.error(`[HIGH] Secret file pattern matched, skipping: ${filePath}`);
      ignored++;
      continue;
    }

    // 1. .polarisignore
    if (ig.ignores(filePath)) {
      ignored++;
      if (verbose) console.log(`  ignored: ${filePath}`);
      continue;
    }

    // 2. exemptions.json
    if (existingExemptions[filePath]) {
      trackedNotIndexed++;
      if (verbose) console.log(`  tracked-not-indexed (exemption): ${filePath}`);
      continue;
    }

    // 3. generatedRoots
    const isGenerated = (config.repo.generatedRoots ?? []).some((root) => {
      const prefix = root.endsWith("/") ? root : `${root}/`;
      return filePath.startsWith(prefix);
    });
    if (isGenerated) {
      newExemptions[filePath] = { classification: "tracked-not-indexed", reason: "generatedRoots" };
      trackedNotIndexed++;
      if (verbose) console.log(`  tracked-not-indexed (generated): ${filePath}`);
      continue;
    }

    // 4. Route inference
    const inferred = inferRoute(filePath, repoRoot, config, existingRoutes, branchName);
    const entry: FileRouteEntry = {
      domain: inferred.domain,
      route: inferred.route,
      taskchain: inferred.taskchain,
      confidence: inferred.confidence,
      classification: inferred.confidence >= (config.map.autoWriteAbove ?? 0.85) ? "indexed" : "needs-review",
      last_updated: now,
      updated_by: "polaris-map-index",
      tags: inferred.tags,
    };

    if (inferred.confidence >= (config.map.autoWriteAbove ?? 0.85)) {
      newRoutes[filePath] = entry;
      mapped++;
      if (verbose) console.log(`  indexed (${inferred.confidence.toFixed(2)}): ${filePath}`);
    } else {
      newNeedsReview[filePath] = entry;
      needsReview++;
      if (verbose) console.log(`  needs-review (${inferred.confidence.toFixed(2)}): ${filePath}`);
    }
  }

  const coveragePct = scanned > 0 ? Math.round((mapped / scanned) * 100) : 0;

  if (!dryRun) {
    writeFileRoutes(outputPath, newRoutes);
    writeNeedsReview(outputPath, newNeedsReview);
    writeExemptions(outputPath, newExemptions);
    writeAtlasIndex(outputPath, {
      scan_date: now,
      file_count: scanned,
      coverage_pct: coveragePct,
      entries: { ...newRoutes, ...newNeedsReview },
    });
  }

  console.log(
    `Scanned ${scanned} files. Mapped ${mapped}. Tracked-not-indexed ${trackedNotIndexed}. Needs-review ${needsReview}. Ignored ${ignored}.`,
  );
  if (dryRun) console.log("(dry-run: no files written)");
}

export function createMapCommand(): Command {
  const map = new Command("map").description("Polaris atlas map commands");

  map
    .command("index")
    .description("Full first-pass atlas generation")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--dry-run", "Print results without writing files")
    .option("-v, --verbose", "Show per-file classification")
    .action((options: { repoRoot: string; dryRun?: boolean; verbose?: boolean }) => {
      runMapIndex(options.repoRoot, options.dryRun ?? false, options.verbose ?? false);
    });

  map
    .command("update")
    .description("Incremental changed-file mapping")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--changed [files...]", "Changed files (omit to detect from git diff)")
    .option("--from-commit <sha>", "Start commit for diff (default: HEAD~1)")
    .option("--to-commit <sha>", "End commit for diff (default: HEAD)")
    .action((options: { repoRoot: string; changed?: string[]; fromCommit?: string; toCommit?: string }) => {
      const files = Array.isArray(options.changed) ? options.changed : [];
      const { hasNeedsReview } = runMapUpdate(options.repoRoot, files, options.fromCommit, options.toCommit);
      const onLowConfidence = loadConfig(options.repoRoot).map.onLowConfidence ?? "warn";
      if (hasNeedsReview && onLowConfidence === "fail") process.exit(1);
    });

  map
    .command("validate")
    .description("Atlas integrity check and needs-review reporting")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--stale-threshold <days>", "Days before an entry is considered stale", "30")
    .option("--fix <path>", "Show and optionally fix entry for a specific file")
    .action((options: { repoRoot: string; staleThreshold: string; fix?: string }) => {
      const { hasError } = runMapValidate(
        options.repoRoot,
        parseInt(options.staleThreshold, 10),
        options.fix,
      );
      if (hasError) process.exit(1);
    });

  map
    .command("query [path]")
    .description("Sidecar metadata lookup by path, glob, or filter")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--domain <domain>", "All files in a domain")
    .option("--taskchain <taskchain>", "All files in a taskchain")
    .option("--text", "Human-readable output instead of JSON")
    .action((pathArg: string | undefined, options: { repoRoot: string; domain?: string; taskchain?: string; text?: boolean }) => {
      runMapQuery(options.repoRoot, pathArg, options.domain, options.taskchain, options.text ?? false);
    });

  return map;
}
