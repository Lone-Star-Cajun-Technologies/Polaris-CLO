import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".polaris", "smartdocs"]);

interface MapEntry {
  doc_path: string;
  route: string;
  title?: string;
}

function normalizeRoute(route: string): string {
  return route.replace(/^\.\//, "").replace(/\/$/, "");
}

function walkForSummaryDirs(dir: string, repoRoot: string, results: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasSummary = entries.some((e) => e.isFile() && e.name === "SUMMARY.md");
  if (hasSummary && dir !== repoRoot) {
    results.push(dir);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    walkForSummaryDirs(join(dir, entry.name), repoRoot, results);
  }
}

function buildLinkedDocsBlock(entries: MapEntry[]): string[] {
  const lines: string[] = ["linked_docs:"];
  for (const entry of entries) {
    const path = entry.doc_path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const title = (entry.title ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`  - path: "${path}"`);
    lines.push(`    title: "${title}"`);
  }
  return lines;
}

function injectLinkedDocs(content: string, entries: MapEntry[]): string {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith("#"));
  if (headingIdx === -1) return content;

  const yamlLines = ["", "---", ...buildLinkedDocsBlock(entries), "---"];

  const before = lines.slice(0, headingIdx + 1);
  const after = lines.slice(headingIdx + 1);
  return [...before, ...yamlLines, ...after].join("\n");
}

export async function enrichCanonFiles(repoRoot: string): Promise<void> {
  const indexPath = join(repoRoot, ".polaris", "map", "index.json");
  if (!existsSync(indexPath)) return;

  const raw = JSON.parse(readFileSync(indexPath, "utf-8")) as Record<string, unknown>;
  // entries may be an array of {doc_path,route,title} OR an object keyed by file path
  const rawEntries = raw["entries"] ?? [];
  const entries: MapEntry[] = Array.isArray(rawEntries)
    ? (rawEntries as MapEntry[])
    : Object.entries(rawEntries as Record<string, Record<string, unknown>>).map(([filePath, meta]) => ({
        doc_path: filePath,
        route: String(meta["route"] ?? ""),
        title: meta["title"] ? String(meta["title"]) : undefined,
      }));

  const summaryDirs: string[] = [];
  walkForSummaryDirs(repoRoot, repoRoot, summaryDirs);

  for (const dir of summaryDirs) {
    const route = normalizeRoute(relative(repoRoot, dir));
    const matched = entries.filter((e) => normalizeRoute(e.route) === route);
    if (matched.length === 0) continue;

    const summaryPath = join(dir, "SUMMARY.md");
    const content = readFileSync(summaryPath, "utf-8");
    if (!content.includes("<!-- polaris:draft -->")) continue;

    writeFileSync(summaryPath, injectLinkedDocs(content, matched), "utf-8");
  }
}
