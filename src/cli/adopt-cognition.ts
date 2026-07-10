import { Dirent, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AdoptionPlan, RepoScanInventory } from "./adoption-plan.js";

const EXCLUDED_SEGMENTS = new Set(["node_modules", "dist", ".git"]);
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".scala",
  ".sh",
]);

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeFolder(path: string): string {
  const normalized = toPosix(path).replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized;
}

function toRootPrefix(path: string): string {
  const normalized = normalizeFolder(path);
  return normalized.length > 0 ? `${normalized}/` : normalized;
}

function isUnderRoot(path: string, roots: string[]): boolean {
  const normalizedPath = normalizeFolder(path);
  return roots
    .map(toRootPrefix)
    .filter((root) => root.length > 0)
    .some((root) => normalizedPath === root.slice(0, -1) || normalizedPath.startsWith(root));
}

function hasExcludedSegments(path: string): boolean {
  const normalized = normalizeFolder(path);
  if (normalized.startsWith(".polaris/runs/") || normalized === ".polaris/runs") {
    return true;
  }
  if (normalized.startsWith(".polaris/bootstrap/") || normalized === ".polaris/bootstrap") {
    return true;
  }
  return normalized.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function isFolderEligible(path: string, inventory: RepoScanInventory): boolean {
  const normalized = normalizeFolder(path);
  if (normalized.length === 0) return false;
  if (normalized === "smartdocs" || normalized.startsWith("smartdocs/")) return false;
  if (isUnderRoot(normalized, inventory.generated_roots)) return false;
  if (isUnderRoot(normalized, inventory.cache_roots)) return false;
  if (isUnderRoot(normalized, inventory.fixture_roots)) return false;
  if (hasExcludedSegments(normalized)) return false;
  return true;
}

function countSourceFiles(dirPath: string, count = 0): number {
  if (count >= 3) {
    return count;
  }

  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return count;
  }

  let sourceCount = count;
  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name);
    const normalized = toPosix(entryPath);

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".git" ||
        normalized.includes("/.polaris/runs/") ||
        normalized.includes("/.polaris/bootstrap/")
      ) {
        continue;
      }
      sourceCount = countSourceFiles(entryPath, sourceCount);
      if (sourceCount >= 3) {
        return sourceCount;
      }
      continue;
    }

    if (entry.isFile()) {
      const dotIndex = entry.name.lastIndexOf(".");
      if (dotIndex > 0 && SOURCE_FILE_EXTENSIONS.has(entry.name.slice(dotIndex).toLowerCase())) {
        sourceCount += 1;
      }
      if (sourceCount >= 3) {
        return sourceCount;
      }
    }
  }

  return sourceCount;
}

function buildPolarisDraft(folder: string): string {
  const folderName = basename(folder);
  return [
    "<!-- polaris:draft -->",
    `# ${folderName}`,
    "",
    "> Polaris draft — route operating guidance. Remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    "## Purpose",
    "",
    "<!-- One paragraph describing what this folder does. -->",
    "",
    "**Domain:** unknown",
    `**Route:** ${folder}`,
    "**Taskchain:** unknown",
    "",
    "## Responsibilities",
    "",
    "<!-- What agents entering this route must know, do, and check. -->",
    "",
    "## Constraints and exclusions",
    "",
    "- Do NOT duplicate doctrine from `smartdocs/doctrine/active/`; link to it instead.",
    "- Do NOT use this file as a run diary; per-run notes belong in the run artifact, not here or in SUMMARY.md.",
    "- Keep guidance operational and directive — this is not a history or index.",
    "",
  ].join("\n");
}

function buildSummaryDraft(folder: string): string {
  const folderName = basename(folder);
  return [
    "<!-- polaris:draft -->",
    `# Summary — ${folderName}`,
    "",
    "> Polaris draft — current-state memory for this route. Remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    `- Route: \`${folder}\``,
    "- Canon status: draft",
    "- Linked doctrine: `POLARIS.md`",
    "",
    "## Current state",
    "",
    "<!-- Synthesized current-state context: what's here, ownership, and domain. -->",
    "",
    "## Synthesized recent changes",
    "",
    "<!-- High-level summary of significant changes, not a per-run diary. Run-specific notes belong in run artifacts. -->",
    "",
    "## Caveats and drift",
    "",
    "<!-- Known gaps, stale areas, or planned changes that affect navigation. -->",
    "",
    "## Canonical sources",
    "",
    "- [POLARIS.md](POLARIS.md) — operational guidance for this route",
    "<!-- Link to relevant doctrine from `smartdocs/doctrine/active/` -->",
    "",
  ].join("\n");
}

export function generateFolderCognition(
  plan: AdoptionPlan,
  inventory: RepoScanInventory,
  repoRoot: string,
): Promise<void> {
  if (plan.dry_run) {
    return Promise.resolve();
  }

  const folders = Array.from(new Set(inventory.likely_canonical_folders.map(normalizeFolder)));

  for (const folder of folders) {
    if (!isFolderEligible(folder, inventory)) {
      continue;
    }

    const absoluteFolder = join(repoRoot, folder);
    if (!existsSync(absoluteFolder)) {
      continue;
    }

    let folderStat;
    try {
      folderStat = statSync(absoluteFolder);
    } catch {
      continue;
    }
    if (!folderStat.isDirectory()) {
      continue;
    }

    if (countSourceFiles(absoluteFolder) < 3) {
      continue;
    }

    const polarisPath = join(absoluteFolder, "POLARIS.md");
    if (existsSync(polarisPath)) {
      continue;
    }

    const summaryPath = join(absoluteFolder, "SUMMARY.md");
    mkdirSync(absoluteFolder, { recursive: true });
    writeFileSync(polarisPath, buildPolarisDraft(folder), "utf-8");
    if (!existsSync(summaryPath)) {
      writeFileSync(summaryPath, buildSummaryDraft(folder), "utf-8");
    }
  }

  return Promise.resolve();
}
