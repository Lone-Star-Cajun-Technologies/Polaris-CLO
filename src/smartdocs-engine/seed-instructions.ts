import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative, join, dirname, basename } from "node:path";
import { loadConfig } from "../config/loader.js";
import { readFileRoutes, readNeedsReview, type FileRouteEntry } from "../map/atlas.js";
import { isDirectoryEligible, type DirectoryEligibilityOptions } from "./smartdoc-ignore.js";
import { parseFrontMatter } from "./doctrine.js";

export const DRAFT_MARKER = "<!-- polaris:draft -->";
export const GENERATED_START_MARKER = "<!-- BEGIN POLARIS GENERATED -->";
export const GENERATED_END_MARKER = "<!-- END POLARIS GENERATED -->";

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

  return [DRAFT_MARKER, GENERATED_START_MARKER, ...lines.slice(1), GENERATED_END_MARKER].join("\n");
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

  return [DRAFT_MARKER, GENERATED_START_MARKER, ...lines.slice(1), GENERATED_END_MARKER].join("\n");
}

const RESERVED_INDEX_NAMES = new Set(["index.md", "POLARIS.md", "SUMMARY.md", "log.md"]);

function isReservedIndexName(name: string): boolean {
  return RESERVED_INDEX_NAMES.has(name);
}

function listConceptFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !isReservedIndexName(e.name))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Immediate child subdirectories eligible for their own index.md (excludes hidden dirs and raw/). */
function listChildDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "raw")
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function conceptLabel(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fm = parseFrontMatter(content);
    const base = basename(filePath);
    return fm.description || fm.title || base.replace(/\.md$/, "");
  } catch {
    return basename(filePath).replace(/\.md$/, "");
  }
}

function collectSmartDocsDirs(dir: string, root: string, result: string[] = []): string[] {
  try {
    const rel = relative(root, dir).replace(/\\/g, "/");
    if (rel.split("/").some((s) => s === "raw" || s.startsWith("."))) {
      return result;
    }
    result.push(rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "raw") continue;
      const full = join(dir, entry.name);
      collectSmartDocsDirs(full, root, result);
    }
  } catch {
    // ignore unreadable dirs
  }
  return result;
}

export function generateBundleRootIndex(
  repoRoot: string,
  allRoutes: Record<string, FileRouteEntry>,
): string {
  const lines: string[] = [
    "---",
    "okf_version: \"0.1\"",
    "type: index",
    "---",
    "",
    DRAFT_MARKER,
    "# SmartDocs — Polaris Cognition Bundle",
    "",
    "> Polaris draft — review and remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    "## Governance",
    "",
  ];

  const doctrineDir = join(repoRoot, "smartdocs", "doctrine", "active");
  const doctrineFiles = listConceptFiles(doctrineDir);
  if (doctrineFiles.length > 0) {
    for (const file of doctrineFiles) {
      const relPath = relative(join(repoRoot, "smartdocs"), file).replace(/\\/g, "/");
      lines.push(`- [${conceptLabel(file)}](${relPath})`);
    }
  } else {
    lines.push("- [Doctrine — Active](doctrine/active/)");
  }
  lines.push("");

  lines.push("## Specs", "");
  const specsDir = join(repoRoot, "smartdocs", "specs", "active");
  const specsFiles = listConceptFiles(specsDir);
  if (specsFiles.length > 0) {
    for (const file of specsFiles) {
      const relPath = relative(join(repoRoot, "smartdocs"), file).replace(/\\/g, "/");
      lines.push(`- [${conceptLabel(file)}](${relPath})`);
    }
  } else {
    lines.push("- [Specs — Active](specs/active/)");
  }
  lines.push("");

  lines.push("## Routes", "");
  const instructionFiles = [
    ...new Set(Object.values(allRoutes).map((e) => e.instructionFile).filter(Boolean)),
  ].sort();
  if (instructionFiles.length > 0) {
    for (const file of instructionFiles) {
      lines.push(`- [${file}](../${file})`);
    }
  } else {
    lines.push("<!-- Route POLARIS.md files will be listed here from atlas signals. -->");
  }
  lines.push("");

  return lines.join("\n");
}

export function generateDirectoryIndex(
  targetDir: string,
  repoRoot: string,
): string {
  const absDir = resolve(repoRoot, targetDir);
  const dirLabel = basename(absDir) || "SmartDocs";
  const files = listConceptFiles(absDir);

  const lines: string[] = [
    "---",
    "okf_version: \"0.1\"",
    "type: index",
    "---",
    "",
    DRAFT_MARKER,
    `# ${dirLabel}`,
    "",
    "> Polaris draft — review and remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    "## Concepts",
    "",
  ];

  if (files.length > 0) {
    for (const file of files) {
      const relPath = relative(absDir, file).replace(/\\/g, "/");
      lines.push(`- [${conceptLabel(file)}](${relPath})`);
    }
  } else {
    lines.push("<!-- No concept files in this directory yet. -->");
  }
  lines.push("");

  const childDirs = listChildDirs(absDir);
  if (childDirs.length > 0) {
    lines.push("## Subdirectories", "");
    for (const child of childDirs) {
      // Always link to the child's index.md rather than checking existsSync: generateDirectoryIndex
      // only ever runs under smartdocs/ (enforced by seedIndex's own path guard), where every
      // eligible subdirectory gets its own index.md — and seedIndexAll writes parents before
      // children in the same pass, so existsSync would be write-order-dependent here.
      lines.push(`- [${child}/](${child}/index.md)`);
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

export function seedIndex(
  targetPath: string,
  repoRoot: string,
  opts: { dryRun?: boolean } = {},
): "written" | "skipped-exists" | "skipped-draft" {
  const absTarget = resolve(repoRoot, targetPath);
  const relCheck = relative(repoRoot, absTarget);
  if (relCheck.startsWith("..") || relCheck.startsWith("/")) {
    throw new Error(`Path traversal detected: target path is outside repo root`);
  }

  // Reject targets outside smartdocs/
  const relTarget = relCheck.replace(/\\/g, "/");
  if (!relTarget.startsWith("smartdocs/") && relTarget !== "smartdocs") {
    throw new Error(`seedIndex only writes index.md under smartdocs/; rejecting target: ${relTarget}`);
  }

  const outFile = join(absTarget, "index.md");

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

  const isBundleRoot = relTarget === "smartdocs";
  const content = isBundleRoot
    ? generateBundleRootIndex(repoRoot, allRoutes)
    : generateDirectoryIndex(relTarget, repoRoot);

  if (!opts.dryRun) {
    writeFileSync(outFile, content, "utf-8");
  }
  return "written";
}

export function seedIndexAll(
  repoRoot: string,
  opts: { dryRun?: boolean } = {},
): SeedAllResult {
  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const allRoutes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };

  const smartdocsRoot = resolve(repoRoot, "smartdocs");
  if (!existsSync(smartdocsRoot)) {
    return { written: [], skippedExists: [], skippedDraft: [], skippedIneligible: [] };
  }

  const dirs = collectSmartDocsDirs(smartdocsRoot, repoRoot);
  const smartdocsRel = "smartdocs";
  if (!dirs.includes(smartdocsRel)) {
    dirs.unshift(smartdocsRel);
  }

  const written: string[] = [];
  const skippedExists: string[] = [];
  const skippedDraft: string[] = [];

  for (const relDir of dirs) {
    const absDir = resolve(repoRoot, relDir);
    const outFile = join(absDir, "index.md");

    if (existsSync(outFile)) {
      if (hasDraftMarker(outFile)) {
        skippedDraft.push(relDir);
      } else {
        skippedExists.push(relDir);
      }
      continue;
    }

    const isBundleRoot = relDir === "smartdocs";
    const content = isBundleRoot
      ? generateBundleRootIndex(repoRoot, allRoutes)
      : generateDirectoryIndex(relDir, repoRoot);

    if (!opts.dryRun) {
      writeFileSync(outFile, content, "utf-8");
    }
    written.push(relDir);
  }

  return { written, skippedExists, skippedDraft, skippedIneligible: [] };
}
