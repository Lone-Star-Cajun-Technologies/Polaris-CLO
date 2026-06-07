import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative, join, dirname, basename } from "node:path";
import { loadConfig } from "../config/loader.js";
import { readFileRoutes, readNeedsReview, type FileRouteEntry } from "../map/atlas.js";
import { isDirectoryEligible, type DirectoryEligibilityOptions } from "./smartdoc-ignore.js";

export const DRAFT_MARKER = "<!-- polaris:draft -->";

export function hasDraftMarker(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.includes(DRAFT_MARKER);
  } catch {
    return false;
  }
}

export interface IneligibleEntry {
  path: string;
  reason: string;
  category?: "runtime" | "agent-cognition" | "hidden" | "ignored" | "root";
}

export interface CollectDirsResult {
  eligible: string[];
  ineligible: IneligibleEntry[];
}

function collectDirs(
  dir: string,
  root: string,
  eligibilityOpts: DirectoryEligibilityOptions = {},
  result: CollectDirsResult = { eligible: [], ineligible: [] },
): CollectDirsResult {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, "/");

      // Check if directory is eligible for Smart Docs coverage
      const eligibility = isDirectoryEligible(full, root, eligibilityOpts);
      if (!eligibility.eligible) {
        result.ineligible.push({
          path: rel,
          reason: eligibility.reason || "unknown",
          category: eligibility.category === "eligible" ? undefined : eligibility.category,
        });
        continue;
      }

      result.eligible.push(rel);
      collectDirs(full, root, eligibilityOpts, result);
    }
  } catch {
    // ignore unreadable dirs
  }
  return result;
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
    "<!-- One paragraph describing what this folder does. -->",
    "",
  ];

  if (domains.length > 0) lines.push(`**Domain:** ${domains.join(", ")}`);
  if (routes.length > 0) lines.push(`**Route:** ${routes.join(", ")}`);
  if (taskchains.length > 0) lines.push(`**Taskchain:** ${taskchains.join(", ")}`);
  if (domains.length + routes.length + taskchains.length > 0) lines.push("");

  lines.push("## What belongs here", "");
  if (filesInDir.length > 0) {
    for (const [filePath, entry] of filesInDir) {
      lines.push(`- \`${basename(filePath)}\` — ${entry.route} (${entry.domain})`);
    }
  } else {
    lines.push("<!-- Bulleted file list of contents. -->");
  }
  lines.push("");

  lines.push("## What does not belong here", "");
  lines.push("<!-- Explicit exclusions of files or responsibilities. -->");
  lines.push("");

  lines.push("## Editing rules", "");
  lines.push("<!-- Behavioral constraints for agents and humans. -->");
  lines.push("");

  lines.push("## Architecture assumptions", "");
  lines.push("<!-- What the code assumes about the world. -->");
  lines.push("");

  lines.push("## Read before editing", "");
  if (nearbyDocs.length > 0) {
    for (const docPath of nearbyDocs) {
      lines.push(`- [${basename(docPath)}](${docPath})`);
    }
  } else {
    lines.push("<!-- Links to canonical sources (doctrine, specs). -->");
  }
  lines.push("");

  lines.push("## Related routes", "");
  lines.push("<!-- Atlas route pointer to sibling or parent folders. -->");
  lines.push("");

  return lines.join("\n");
}

export function generateSummaryDraft(
  targetDir: string,
  repoRoot: string,
  _allRoutes: Record<string, FileRouteEntry>,
): string {
  const dirLabel = basename(targetDir) || basename(repoRoot);

  const lines: string[] = [
    DRAFT_MARKER,
    `# Summary: ${dirLabel}`,
    "",
    "> Polaris draft — review and remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    "## Purpose",
    "<!-- One-line statement of what this folder does. -->",
    "",
    "## Core Concepts",
    "<!-- 3–7 key concepts a reader needs before diving into source. -->",
    "",
    "## Architectural Role",
    "<!-- How this folder fits into the larger system. -->",
    "",
    "## Key Constraints",
    "<!-- The most important non-obvious behavioral limits. -->",
    "",
    "## Important Relationships",
    "<!-- Upstream/downstream dependencies on other folders. -->",
    "",
    "## Current State",
    "<!-- What is implemented, what is not yet, known gaps. -->",
    "",
    "## Route Health",
    "<!-- Current operational condition. Workers should understand route health in under 10 seconds. -->",
    "",
    "### Healthy",
    "<!-- If the route is healthy, state why. Otherwise omit this subsection. -->",
    "",
    "### Monitoring",
    "<!-- Any ongoing monitoring or observations. Omit if none. -->",
    "",
    "### Known Issues",
    "<!-- Any known problems or risks. Omit if none. -->",
    "",
    "### Recent Treatments",
    "<!-- Recent fixes or improvements, with chart references if applicable. Omit if none. -->",
    "",
    "### Improvement Opportunities",
    "<!-- Potential future improvements. Omit if none. -->",
    "",
    "## Canonical References",
    "",
    "```yaml",
    "canonical_docs:",
    "  - POLARIS.md",
    "<!-- Add navigation paths to canonical docs, specs, or doctrine. These are retrieval paths, not reading assignments. -->",
    "```",
    "",
    "## Known Drift",
    "<!-- Places where the summary may be stale (honesty field). -->",
    "",
  ];

  return lines.join("\n");
}

export function seedInstructions(
  targetPath: string,
  repoRoot: string,
  opts: { dryRun?: boolean } = {},
): "written" | "skipped-exists" | "skipped-draft" {
  const absTarget = resolve(repoRoot, targetPath);
  // Path traversal check: ensure absTarget is within repoRoot
  const relCheck = relative(repoRoot, absTarget);
  if (relCheck.startsWith("..") || relCheck.startsWith("/")) {
    throw new Error(`Path traversal detected: target path is outside repo root`);
  }
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

export function seedSummary(
  targetPath: string,
  repoRoot: string,
  opts: { dryRun?: boolean } = {},
): "written" | "skipped-exists" | "skipped-draft" {
  const absTarget = resolve(repoRoot, targetPath);
  const relCheck = relative(repoRoot, absTarget);
  if (relCheck.startsWith("..") || relCheck.startsWith("/")) {
    throw new Error(`Path traversal detected: target path is outside repo root`);
  }
  const outFile = join(absTarget, "SUMMARY.md");

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
  const content = generateSummaryDraft(relTarget, repoRoot, allRoutes);

  if (!opts.dryRun) {
    writeFileSync(outFile, content, "utf-8");
  }
  return "written";
}

export interface SeedAllOptions {
  dryRun?: boolean;
  includeAgentFolders?: boolean;
  includeHidden?: boolean;
  includeRoot?: boolean;
}

export interface SeedAllResult {
  written: string[];
  skippedExists: string[];
  skippedDraft: string[];
  skippedIneligible: IneligibleEntry[];
  skippedRoot?: { path: string; reason: string };
}

export function seedInstructionsAll(
  repoRoot: string,
  opts: SeedAllOptions = {},
): SeedAllResult {
  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const allRoutes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };

  // Root handling: skipped by default for POLARIS.md (root uses AGENTS.md/CLAUDE.md)
  const rootEligibility = isDirectoryEligible(repoRoot, repoRoot, {
    isRoot: true,
    skipRoot: opts.includeRoot ? false : true,
  });

  let skippedRoot: { path: string; reason: string } | undefined;
  if (!rootEligibility.eligible) {
    skippedRoot = { path: ".", reason: rootEligibility.reason || "root skipped" };
  }

  // Collect eligible subdirectories
  const eligibilityOpts: DirectoryEligibilityOptions = {
    includeAgentFolders: opts.includeAgentFolders,
    includeHidden: opts.includeHidden,
    skipRoot: true, // Always skip root in collectDirs, we handle it separately
  };

  const { eligible: dirs, ineligible: skippedIneligible } = collectDirs(repoRoot, repoRoot, eligibilityOpts);

  // Build the list of dirs to process
  const dirsToProcess: string[] = [];
  if (rootEligibility.eligible) {
    dirsToProcess.push(".");
  }
  dirsToProcess.push(...dirs);

  const written: string[] = [];
  const skippedExists: string[] = [];
  const skippedDraft: string[] = [];

  for (const relDir of dirsToProcess) {
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

  return { written, skippedExists, skippedDraft, skippedIneligible, skippedRoot };
}

export function seedSummaryAll(
  repoRoot: string,
  opts: SeedAllOptions = {},
): SeedAllResult {
  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const allRoutes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };

  // Root handling: skipped by default for SUMMARY.md (match POLARIS.md behavior)
  const rootEligibility = isDirectoryEligible(repoRoot, repoRoot, {
    isRoot: true,
    skipRoot: opts.includeRoot ? false : true,
  });

  let skippedRoot: { path: string; reason: string } | undefined;
  if (!rootEligibility.eligible) {
    skippedRoot = { path: ".", reason: rootEligibility.reason || "root skipped" };
  }

  // Collect eligible subdirectories
  const eligibilityOpts: DirectoryEligibilityOptions = {
    includeAgentFolders: opts.includeAgentFolders,
    includeHidden: opts.includeHidden,
    skipRoot: true, // Always skip root in collectDirs, we handle it separately
  };

  const { eligible: dirs, ineligible: skippedIneligible } = collectDirs(repoRoot, repoRoot, eligibilityOpts);

  // Build the list of dirs to process
  const dirsToProcess: string[] = [];
  if (rootEligibility.eligible) {
    dirsToProcess.push(".");
  }
  dirsToProcess.push(...dirs);

  const written: string[] = [];
  const skippedExists: string[] = [];
  const skippedDraft: string[] = [];

  for (const relDir of dirsToProcess) {
    const absDir = resolve(repoRoot, relDir);
    const outFile = join(absDir, "SUMMARY.md");

    if (existsSync(outFile)) {
      if (hasDraftMarker(outFile)) {
        skippedDraft.push(relDir);
      } else {
        skippedExists.push(relDir);
      }
      continue;
    }

    const content = generateSummaryDraft(relDir, repoRoot, allRoutes);
    if (!opts.dryRun) {
      writeFileSync(outFile, content, "utf-8");
    }
    written.push(relDir);
  }

  return { written, skippedExists, skippedDraft, skippedIneligible, skippedRoot };
}
