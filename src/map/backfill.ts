import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { parsePolarisIgnore } from "../ignore/parser.js";
import { SECRET_PATTERNS } from "../ignore/defaults.js";
import { inferRoute } from "./inference.js";
import {
  readFileRoutes,
  readNeedsReview,
  readExemptions,
  writeFileRoutes,
  writeNeedsReview,
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
  if (!existsSync(dir)) return;
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

function getBranchName(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
  } catch {
    return "";
  }
}

export function runMapBackfill(
  repoRoot: string,
  dryRun: boolean,
  domainFilter: string | undefined,
  verbose: boolean,
): void {
  const config = loadConfig(repoRoot);
  const outputPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");

  if (!existsSync(resolve(outputPath, "file-routes.json"))) {
    console.error("atlas not initialized — run `polaris map index` first");
    process.exit(1);
  }

  const routes = readFileRoutes(outputPath);
  const needsReview = readNeedsReview(outputPath);
  const exemptions = readExemptions(outputPath);
  const ig = loadIgnoreFilter(repoRoot);
  const branchName = getBranchName(repoRoot);

  const autoWriteAbove = config.map.autoWriteAbove ?? 0.85;
  const now = new Date().toISOString();

  const newRoutes = { ...routes };
  const newNeedsReview = { ...needsReview };

  let added = 0;
  let queued = 0;
  let skippedSecret = 0;
  let skippedAlreadyMapped = 0;
  let skippedExempted = 0;
  let skippedIgnored = 0;

  const scanRoots = [
    ...(config.repo.sourceRoots ?? ["src"]),
    ...(config.repo.docsRoots ?? []),
  ];

  for (const scanRoot of scanRoots) {
    const scanDir = resolve(repoRoot, scanRoot);

    for (const filePath of walkDir(scanDir, repoRoot)) {
      // Apply --domain filter: only process files under sourceRoot/domain/
      if (domainFilter !== undefined) {
        const domainPrefix = `${scanRoot}/${domainFilter}/`;
        if (!filePath.startsWith(domainPrefix)) continue;
      }

      // Security check — never process secret files
      if (isSecretFile(filePath)) {
        console.log(`  [HIGH] secret file skipped: ${filePath}`);
        skippedSecret++;
        continue;
      }

      // Skip if already mapped (never overwrite)
      if (routes[filePath] || needsReview[filePath]) {
        skippedAlreadyMapped++;
        if (verbose) console.log(`  skip (already mapped): ${filePath}`);
        continue;
      }

      // Skip if exempted
      if (exemptions[filePath]) {
        skippedExempted++;
        if (verbose) console.log(`  skip (exempted): ${filePath}`);
        continue;
      }

      // Skip if ignored
      if (ig.ignores(filePath)) {
        skippedIgnored++;
        if (verbose) console.log(`  skip (ignored): ${filePath}`);
        continue;
      }

      // Run inference on unmapped file
      const inferred = inferRoute(filePath, repoRoot, config, routes, branchName);
      const entry: FileRouteEntry = {
        domain: inferred.domain,
        route: inferred.route,
        taskchain: inferred.taskchain,
        confidence: inferred.confidence,
        classification: inferred.confidence >= autoWriteAbove ? "indexed" : "needs-review",
        last_updated: now,
        updated_by: "polaris-map-backfill",
        tags: inferred.tags,
      };

      if (inferred.confidence >= autoWriteAbove) {
        newRoutes[filePath] = entry;
        added++;
        if (verbose) console.log(`  add (${inferred.confidence.toFixed(2)}): ${filePath}`);
      } else {
        newNeedsReview[filePath] = entry;
        queued++;
        if (verbose) console.log(`  queue (${inferred.confidence.toFixed(2)}): ${filePath}`);
      }
    }
  }

  const total = added + queued;

  if (!dryRun && total > 0) {
    writeFileRoutes(outputPath, newRoutes);
    writeNeedsReview(outputPath, newNeedsReview);

    const allEntries = { ...newRoutes, ...newNeedsReview };
    const totalEntries = Object.keys(allEntries).length;
    const indexedCount = Object.values(allEntries).filter((e) => e.classification === "indexed").length;
    writeAtlasIndex(outputPath, {
      scan_date: now,
      file_count: totalEntries,
      coverage_pct: totalEntries > 0 ? Math.round((indexedCount / totalEntries) * 100) : 0,
      entries: allEntries,
    });
  }

  const skipped = skippedSecret + skippedAlreadyMapped + skippedExempted + skippedIgnored;
  console.log(`Backfilled ${total} files. Added ${added}. Queued ${queued} for review. Skipped ${skipped} (secret: ${skippedSecret}, already mapped: ${skippedAlreadyMapped}, exempted: ${skippedExempted}, ignored: ${skippedIgnored}).`);
  if (dryRun) console.log("(dry-run: no files written)");
}
