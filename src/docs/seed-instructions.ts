import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative, join, dirname, basename } from "node:path";
import { loadConfig } from "../config/loader.js";
import { readFileRoutes, readNeedsReview, type FileRouteEntry } from "../map/atlas.js";

export const DRAFT_MARKER = "<!-- polaris:draft -->";

export function hasDraftMarker(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.includes(DRAFT_MARKER);
  } catch {
    return false;
  }
}

function collectDirs(dir: string, root: string): string[] {
  const dirs: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
        const full = join(dir, entry.name);
        const rel = relative(root, full).replace(/\\/g, "/");
        dirs.push(rel);
        dirs.push(...collectDirs(full, root));
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return dirs;
}

export function generateDraft(
  targetDir: string,
  repoRoot: string,
  allRoutes: Record<string, FileRouteEntry>,
): string {
  const filesInDir = Object.entries(allRoutes).filter(([filePath]) => {
    const fileDir = dirname(filePath);
    const normDir = targetDir.replace(/\\/g, "/");
    return fileDir === normDir || (normDir === "." && !filePath.includes("/"));
  });

  const domains = [...new Set(filesInDir.map(([, e]) => e.domain))].filter(Boolean);
  const routes = [...new Set(filesInDir.map(([, e]) => e.route))].filter(Boolean);
  const taskchains = [...new Set(filesInDir.map(([, e]) => e.taskchain))].filter(Boolean);

  // Nearby doc references: .md files in atlas whose route overlaps with this dir's routes
  const nearbyDocs = Object.entries(allRoutes)
    .filter(([p]) => p.endsWith(".md") || p.startsWith("docs/"))
    .filter(([, e]) => routes.some((r) => e.route === r || e.domain === domains[0]))
    .map(([p]) => p)
    .slice(0, 5);

  const dirLabel = basename(targetDir) || basename(repoRoot);

  const lines: string[] = [
    DRAFT_MARKER,
    `# ${dirLabel}`,
    "",
    "> Polaris draft — review and remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    "## Purpose",
    "",
    "<!-- Replace with a description of what this directory does and its key responsibilities. -->",
    "",
  ];

  if (domains.length > 0) lines.push(`**Domain:** ${domains.join(", ")}`);
  if (routes.length > 0) lines.push(`**Route:** ${routes.join(", ")}`);
  if (taskchains.length > 0) lines.push(`**Taskchain:** ${taskchains.join(", ")}`);
  if (domains.length + routes.length + taskchains.length > 0) lines.push("");

  if (filesInDir.length > 0) {
    lines.push("## Files", "");
    for (const [filePath, entry] of filesInDir) {
      lines.push(`- \`${basename(filePath)}\` — ${entry.route} (${entry.domain})`);
    }
    lines.push("");
  }

  if (nearbyDocs.length > 0) {
    lines.push("## Nearby docs", "");
    for (const docPath of nearbyDocs) {
      lines.push(`- \`${docPath}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function seedInstructions(
  targetPath: string,
  repoRoot: string,
  opts: { dryRun?: boolean } = {},
): "written" | "skipped-exists" | "skipped-draft" {
  const absTarget = resolve(repoRoot, targetPath);
  const outFile = join(absTarget, "POLARIS.md");

  if (existsSync(outFile)) {
    if (hasDraftMarker(outFile)) {
      return "skipped-draft";
    }
    return "skipped-exists";
  }

  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const allRoutes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };

  const relTarget = relative(repoRoot, absTarget).replace(/\\/g, "/");
  const content = generateDraft(relTarget, repoRoot, allRoutes);

  if (!opts.dryRun) {
    writeFileSync(outFile, content, "utf-8");
  }
  return "written";
}

export function seedInstructionsAll(
  repoRoot: string,
  opts: { dryRun?: boolean } = {},
): { written: string[]; skippedExists: string[]; skippedDraft: string[] } {
  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const allRoutes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };

  const dirs = collectDirs(repoRoot, repoRoot);
  const written: string[] = [];
  const skippedExists: string[] = [];
  const skippedDraft: string[] = [];

  for (const relDir of dirs) {
    const absDir = resolve(repoRoot, relDir);
    const outFile = join(absDir, "POLARIS.md");

    if (existsSync(outFile)) {
      if (hasDraftMarker(outFile)) {
        skippedDraft.push(relDir);
      } else {
        skippedExists.push(relDir);
      }
      continue;
    }

    const content = generateDraft(relDir, repoRoot, allRoutes);
    if (!opts.dryRun) {
      writeFileSync(outFile, content, "utf-8");
    }
    written.push(relDir);
  }

  return { written, skippedExists, skippedDraft };
}
