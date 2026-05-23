import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
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

function getChangedFiles(repoRoot: string, fromCommit?: string, toCommit?: string): string[] {
  const from = fromCommit ?? "HEAD~1";
  const to = toCommit ?? "HEAD";
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${from}..${to}`], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    if (!output) return [];
    return output.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch {
    // Fall back to unstaged changes if no commits
    try {
      const output = execFileSync("git", ["diff", "--name-only"], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
      }).toString().trim();
      if (!output) return [];
      return output.split("\n").map((f) => f.trim()).filter(Boolean);
    } catch {
      return [];
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

export interface UpdateSummary {
  mapped: number;
  validated: number;
  inferred: number;
  needs_review: number;
  ignored: number;
}

export function runMapUpdate(
  repoRoot: string,
  explicitFiles: string[],
  fromCommit?: string,
  toCommit?: string,
): { summary: UpdateSummary; hasNeedsReview: boolean } {
  const config = loadConfig(repoRoot);
  const outputPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const ig = loadIgnoreFilter(repoRoot);

  const changedFiles = explicitFiles.length > 0
    ? explicitFiles
    : getChangedFiles(repoRoot, fromCommit, toCommit);

  const routes = readFileRoutes(outputPath);
  const needsReview = readNeedsReview(outputPath);
  const exemptions = readExemptions(outputPath);

  let branchName = "";
  try {
    branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
  } catch { /* ignore */ }

  const summary: UpdateSummary = { mapped: 0, validated: 0, inferred: 0, needs_review: 0, ignored: 0 };
  const now = new Date().toISOString();

  for (const filePath of changedFiles) {
    // Security check
    if (isSecretFile(filePath)) {
      console.error(`[HIGH] Secret file pattern matched, skipping: ${filePath}`);
      summary.ignored++;
      continue;
    }

    // 1. .polarisignore
    if (ig.ignores(filePath)) {
      summary.ignored++;
      continue;
    }

    // 2. Existing entry in file-routes.json → validate and update timestamp
    if (routes[filePath]) {
      routes[filePath]!.last_updated = now;
      routes[filePath]!.updated_by = "polaris-map-update";
      summary.validated++;
      continue;
    }

    // 3. Tracked-not-indexed → skip
    if (exemptions[filePath]) {
      summary.ignored++;
      continue;
    }

    // 4. File doesn't exist on disk (deleted) → remove from needs-review if present, skip
    if (!existsSync(resolve(repoRoot, filePath))) {
      delete needsReview[filePath];
      summary.ignored++;
      continue;
    }

    // 5. Run inference for new file
    const inferred = inferRoute(filePath, repoRoot, config, routes, branchName);
    const autoWriteAbove = config.map.autoWriteAbove ?? 0.85;
    const confidenceThreshold = config.map.confidenceThreshold ?? 0.75;
    const entry: FileRouteEntry = {
      domain: inferred.domain,
      route: inferred.route,
      taskchain: inferred.taskchain,
      confidence: inferred.confidence,
      classification: inferred.confidence >= autoWriteAbove ? "indexed" : "needs-review",
      last_updated: now,
      updated_by: "polaris-map-update",
      tags: inferred.tags,
    };

    if (inferred.confidence >= autoWriteAbove) {
      routes[filePath] = entry;
      summary.inferred++;
      summary.mapped++;
    } else {
      needsReview[filePath] = entry;
      summary.needs_review++;
      if (inferred.confidence >= confidenceThreshold) {
        // Between thresholds: also track in needs-review but don't fail by default
      } else {
        const onLow = config.map.onLowConfidence ?? "warn";
        if (onLow === "warn") {
          console.error(`[WARN] Low confidence (${inferred.confidence.toFixed(2)}) for ${filePath} — added to needs-review`);
        }
      }
    }
  }

  writeFileRoutes(outputPath, routes);
  writeNeedsReview(outputPath, needsReview);

  const allEntries = { ...routes, ...needsReview };
  const totalFiles = Object.keys(allEntries).length;
  const indexedCount = Object.values(allEntries).filter((e) => e.classification === "indexed").length;
  writeAtlasIndex(outputPath, {
    scan_date: now,
    file_count: totalFiles,
    coverage_pct: totalFiles > 0 ? Math.round((indexedCount / totalFiles) * 100) : 0,
    entries: allEntries,
  });

  console.log(JSON.stringify(summary));
  return { summary, hasNeedsReview: summary.needs_review > 0 };
}
