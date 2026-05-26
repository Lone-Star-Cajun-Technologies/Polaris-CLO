import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { runMapUpdate } from "./update.js";
import { runMapValidate } from "./validate.js";
import { runMapQuery } from "./query.js";
import { runMapBackfill } from "./backfill.js";
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
  resolveInstructionFile,
  computeInstructionCoverage,
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

function* walkDir(
  dir: string,
  root: string,
  ig?: ReturnType<typeof parsePolarisIgnore>,
): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (ig?.ignores(rel + "/")) continue;
      yield* walkDir(full, root, ig);
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
  if (!existsSync(repoRoot)) {
    console.error(`Repo root not found: ${repoRoot}`);
    process.exit(1);
  }

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

  for (const filePath of walkDir(repoRoot, repoRoot, ig)) {
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
      instructionFile: resolveInstructionFile(filePath, repoRoot),
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
    const allEntries = { ...newRoutes, ...newNeedsReview };
    writeAtlasIndex(outputPath, {
      scan_date: now,
      file_count: scanned,
      coverage_pct: coveragePct,
      instructionCoverage: computeInstructionCoverage(allEntries),
      entries: allEntries,
    });
  }

  console.log(
    `Scanned ${scanned} files. Mapped ${mapped}. Tracked-not-indexed ${trackedNotIndexed}. Needs-review ${needsReview}. Ignored ${ignored}.`,
  );
  if (dryRun) console.log("(dry-run: no files written)");
}

export interface MapCommandHandlers {
  runMapIndex?: typeof runMapIndex;
  runMapUpdate?: typeof runMapUpdate;
  runMapValidate?: typeof runMapValidate;
  runMapBackfill?: typeof runMapBackfill;
  runMapQuery?: typeof runMapQuery;
  repoRoot?: string;
}

function failMissingSubcommand(command: Command, commandName: string): never {
  const unknownSubcommand = command.args[0];
  const message = unknownSubcommand
    ? `error: unknown command '${unknownSubcommand}' for '${commandName}'. Run '${commandName} --help'.`
    : `error: missing command for '${commandName}'. Run '${commandName} --help'.`;
  command.error(message, {
    code: "commander.missingCommand",
    exitCode: 1,
  });
}

export function createMapCommand(handlers: MapCommandHandlers = {}): Command {
  const indexHandler = handlers.runMapIndex ?? runMapIndex;
  const updateHandler = handlers.runMapUpdate ?? runMapUpdate;
  const validateHandler = handlers.runMapValidate ?? runMapValidate;
  const backfillHandler = handlers.runMapBackfill ?? runMapBackfill;
  const queryHandler = handlers.runMapQuery ?? runMapQuery;
  const repoRootDefault = handlers.repoRoot ?? process.cwd();
  const map = new Command("map")
    .description("Polaris atlas map commands: --dry-run is a non-mutating preview")
    .showHelpAfterError()
    .showSuggestionAfterError();
  map.action(() => failMissingSubcommand(map, "polaris map"));

  map
    .command("index")
    .description("mutating: full first-pass atlas generation")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--dry-run", "non-mutating preview: print results without writing files")
    .option("-v, --verbose", "Show per-file classification")
    .action((options: { repoRoot: string; dryRun?: boolean; verbose?: boolean }) => {
      indexHandler(options.repoRoot, options.dryRun ?? false, options.verbose ?? false);
    });

  map
    .command("update")
    .description("mutating: incremental changed-file mapping")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--changed [files...]", "Changed files (omit to detect from git diff)")
    .option("--from-commit <sha>", "Start commit for diff (default: HEAD~1)")
    .option("--to-commit <sha>", "End commit for diff (default: HEAD)")
    .action((options: { repoRoot: string; changed?: string[]; fromCommit?: string; toCommit?: string }) => {
      const files = Array.isArray(options.changed) ? options.changed : [];
      const { hasNeedsReview } = updateHandler(options.repoRoot, files, options.fromCommit, options.toCommit);
      const onLowConfidence = loadConfig(options.repoRoot).map.onLowConfidence ?? "warn";
      if (hasNeedsReview && onLowConfidence === "fail") process.exit(1);
    });

  map
    .command("validate")
    .description("safe/read-only by default: atlas integrity check and needs-review reporting")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--stale-threshold <days>", "Days before an entry is considered stale", "30")
    .option("--fix <path>", "Show and optionally fix entry for a specific file")
    .action((options: { repoRoot: string; staleThreshold: string; fix?: string }) => {
      const { hasError } = validateHandler(
        options.repoRoot,
        parseInt(options.staleThreshold, 10),
        options.fix,
      );
      if (hasError) process.exit(1);
    });

  map
    .command("backfill")
    .description("mutating unless --dry-run: incremental gap-fill for an already-indexed repo")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--dry-run", "non-mutating preview: print results without writing files")
    .option("--domain <domain>", "Limit backfill to a specific domain")
    .option("-v, --verbose", "Show per-file classification")
    .action((options: { repoRoot: string; dryRun?: boolean; domain?: string; verbose?: boolean }) => {
      backfillHandler(options.repoRoot, options.dryRun ?? false, options.domain, options.verbose ?? false);
    });

  map
    .command("query [path]")
    .description("safe/read-only: sidecar metadata lookup by path, glob, or filter")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--domain <domain>", "All files in a domain")
    .option("--taskchain <taskchain>", "All files in a taskchain")
    .option("--text", "Human-readable output instead of JSON")
    .option("--include-instructions", "Include POLARIS.md instruction file path and content in output")
    .action((pathArg: string | undefined, options: { repoRoot: string; domain?: string; taskchain?: string; text?: boolean; includeInstructions?: boolean }) => {
      queryHandler(options.repoRoot, pathArg, options.domain, options.taskchain, options.text ?? false, options.includeInstructions ?? false);
    });

  return map;
}
