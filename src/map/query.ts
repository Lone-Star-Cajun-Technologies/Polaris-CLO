import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import { parsePolarisIgnore } from "../ignore/parser.js";
import {
  readFileRoutes,
  readNeedsReview,
  readExemptions,
  type FileRouteEntry,
} from "./atlas.js";

type QueryEntry =
  | { classification: "indexed" | "needs-review"; domain: string; route: string; taskchain: string; confidence: number; last_updated: string; tags: string[] }
  | { classification: "ignored" | "tracked-not-indexed" | "unmapped" };

function globToRegex(pattern: string): RegExp {
  let regStr = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      regStr += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (c === "*") {
      regStr += "[^/]*";
      i++;
    } else if (c === "?") {
      regStr += "[^/]";
      i++;
    } else if (".+^${}[]|()\\".includes(c)) {
      regStr += "\\" + c;
      i++;
    } else {
      regStr += c;
      i++;
    }
  }
  return new RegExp("^" + regStr + "$");
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

function toQueryEntry(entry: FileRouteEntry): QueryEntry {
  return {
    domain: entry.domain,
    route: entry.route,
    taskchain: entry.taskchain,
    confidence: entry.confidence,
    classification: entry.classification === "needs-review" ? "needs-review" : "indexed",
    last_updated: entry.last_updated,
    tags: entry.tags,
  };
}

function resolveEntry(
  filePath: string,
  routes: Record<string, FileRouteEntry>,
  needsReview: Record<string, FileRouteEntry>,
  exemptions: Record<string, { classification: string }>,
  ig: ReturnType<typeof parsePolarisIgnore>,
): QueryEntry {
  if (routes[filePath]) return toQueryEntry(routes[filePath]!);
  if (needsReview[filePath]) return toQueryEntry(needsReview[filePath]!);
  if (exemptions[filePath]) return { classification: exemptions[filePath]!.classification as "tracked-not-indexed" | "ignored" };
  if (ig.ignores(filePath)) return { classification: "ignored" };
  return { classification: "unmapped" };
}

function printText(result: Record<string, QueryEntry>): void {
  for (const [filePath, entry] of Object.entries(result)) {
    const parts: string[] = [filePath, entry.classification];
    if ("domain" in entry) {
      parts.push(`domain:${entry.domain}`, `route:${entry.route}`, `taskchain:${entry.taskchain}`, `conf:${entry.confidence.toFixed(2)}`);
    }
    console.log(parts.join("  "));
  }
}

export function runMapQuery(
  repoRoot: string,
  pathArg: string | undefined,
  domain: string | undefined,
  taskchain: string | undefined,
  textMode: boolean,
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

  const result: Record<string, QueryEntry> = {};

  if (domain !== undefined) {
    for (const [filePath, entry] of [...Object.entries(routes), ...Object.entries(needsReview)]) {
      if (entry.domain === domain) result[filePath] = toQueryEntry(entry);
    }
  } else if (taskchain !== undefined) {
    for (const [filePath, entry] of [...Object.entries(routes), ...Object.entries(needsReview)]) {
      if (entry.taskchain === taskchain) result[filePath] = toQueryEntry(entry);
    }
  } else if (pathArg !== undefined) {
    const isGlobPattern = pathArg.includes("*") || pathArg.includes("?");
    const isDir = !isGlobPattern && pathArg.endsWith("/");

    if (isGlobPattern) {
      const re = globToRegex(pathArg);
      const allPaths = new Set([...Object.keys(routes), ...Object.keys(needsReview), ...Object.keys(exemptions)]);
      for (const filePath of allPaths) {
        if (re.test(filePath)) result[filePath] = resolveEntry(filePath, routes, needsReview, exemptions, ig);
      }
    } else if (isDir) {
      const prefix = pathArg;
      const allPaths = new Set([...Object.keys(routes), ...Object.keys(needsReview), ...Object.keys(exemptions)]);
      for (const filePath of allPaths) {
        if (filePath.startsWith(prefix)) result[filePath] = resolveEntry(filePath, routes, needsReview, exemptions, ig);
      }
    } else {
      if (!existsSync(resolve(repoRoot, pathArg))) {
        process.stderr.write(`warn: file does not exist in repo: ${pathArg}\n`);
      }
      result[pathArg] = resolveEntry(pathArg, routes, needsReview, exemptions, ig);
    }
  } else {
    console.error("polaris map query: specify a path, glob, or --domain/--taskchain filter");
    process.exit(1);
  }

  if (textMode) {
    printText(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
