import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { readFileRoutes, readNeedsReview } from "../map/atlas.js";
import {
  generateDraft,
  GENERATED_END_MARKER,
  GENERATED_START_MARKER,
  TEMPLATE_VERSION,
  type CollectDirsResult,
  type IneligibleEntry,
} from "./seed-instructions.js";
import { isDirectoryEligible, type DirectoryEligibilityOptions } from "./smartdoc-ignore.js";

export type FindingSeverity = "OK" | "WARN" | "ERROR" | "MISSING";

export interface Finding {
  severity: Exclude<FindingSeverity, "OK">;
  message: string;
}

const DEFAULT_PAIRWISE_DRIFT_THRESHOLD = 0.5;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize route artifact text so shared boilerplate (headings, links, route
 * names) does not dominate similarity scores.
 */
function normalizeRouteArtifact(content: string, routeName?: string): string {
  let s = content.toLowerCase();
  // Strip markdown headings
  s = s.replace(/^#+\s+.*$/gm, " ");
  // Remove link URLs but keep link text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove bare URLs
  s = s.replace(/https?:\/\/\S+/g, " ");
  // Remove route name tokens
  if (routeName) {
    for (const token of routeName.split(/[-_\s]+/).filter(Boolean)) {
      s = s.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"), " ");
    }
  }
  // Drop non-alphanumeric characters
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Compute a normalized Jaccard similarity between two route artifacts.
 * Returns a value between 0 and 1.
 */
function computeNormalizedSimilarity(a: string, b: string, routeName?: string): number {
  const tokensA = new Set(normalizeRouteArtifact(a, routeName).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeRouteArtifact(b, routeName).split(" ").filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 0;
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export interface ValidationResult {
  dir: string;
  polarisFile: string | null;
  status: FindingSeverity;
  findings: Finding[];
}

/**
 * Get the last git modification date of a file.
 * Returns null if the file is untracked or git is unavailable.
 */
export function getLastGitModDate(filePath: string, repoRoot: string): Date | null {
  try {
    const rel = relative(repoRoot, filePath).replace(/\\/g, "/");
    const out = execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%cI", "--", rel], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (!out) return null;
    return new Date(out);
  } catch {
    return null;
  }
}

/**
 * Get files in a directory that were modified after a given date (via git log).
 * Only considers files directly in the directory (not subdirs).
 */
export function getFilesChangedAfter(
  dir: string,
  since: Date,
  repoRoot: string,
): string[] {
  try {
    const relDir = relative(repoRoot, dir).replace(/\\/g, "/");
    const pattern = relDir ? `${relDir}/*` : "*";
    const isoDate = since.toISOString();
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "log", `--after=${isoDate}`, "--name-only", "--format=", "--", pattern],
      { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();
    if (!out) return [];
    const files = out
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => {
        // Only files directly in the target dir (not nested subdirs)
        const fileDir = dirname(f);
        const normRelDir = relDir || ".";
        return fileDir === normRelDir || (normRelDir === "." && !f.includes("/"));
      });
    // Deduplicate
    return [...new Set(files)];
  } catch {
    return [];
  }
}

/**
 * Parse "Read before editing" section of a POLARIS.md and extract linked file paths.
 * Looks for markdown links: [text](path)
 */
export function parseReadBeforeEditingLinks(content: string): string[] {
  const links: string[] = [];
  const sectionRe = /^##\s+Read before editing/im;
  const nextSectionRe = /^##\s+/im;

  const sectionMatch = sectionRe.exec(content);
  if (!sectionMatch) return links;

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const remainder = content.slice(sectionStart);
  const nextMatch = nextSectionRe.exec(remainder);
  const sectionText = nextMatch ? remainder.slice(0, nextMatch.index) : remainder;

  // Match markdown links: [text](path)
  const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(sectionText)) !== null) {
    const href = m[2].trim();
    // Skip external URLs
    if (!href.startsWith("http://") && !href.startsWith("https://")) {
      links.push(href);
    }
  }

  return links;
}

function extractGeneratedRegion(content: string): string | null {
  const start = content.indexOf(GENERATED_START_MARKER);
  const end = content.indexOf(GENERATED_END_MARKER);
  if (start === -1 || end === -1 || start >= end) return null;
  return content.slice(start + GENERATED_START_MARKER.length, end).trim();
}

function parseTemplateVersionStamp(content: string): number | undefined {
  const match = content.match(/<!--\s*polaris:template-version:\s*(\d+)\s*-->/);
  if (!match) return undefined;
  return parseInt(match[1], 10);
}

function checkTemplateVersionStamp(content: string, fileLabel: string): Finding | null {
  const version = parseTemplateVersionStamp(content);
  if (version === undefined) {
    return { severity: "WARN", message: `${fileLabel} is unstamped (no template-version stamp)` };
  }
  if (version !== TEMPLATE_VERSION) {
    return {
      severity: "WARN",
      message: `${fileLabel} template version drift: found ${version}, expected ${TEMPLATE_VERSION}`,
    };
  }
  return null;
}

function getRequiredDirs(repoRoot: string): string[] {
  const config = loadConfig(repoRoot);
  // The config type may not yet have a docs key; access dynamically
  const docsConfig = (config as Record<string, unknown>)["docs"] as
    | { instructionFiles?: { required?: string[] } }
    | undefined;
  return docsConfig?.instructionFiles?.required ?? [];
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

/**
 * Validate a single directory's POLARIS.md.
 */
export function validateDir(
  relDir: string,
  repoRoot: string,
  allRoutes: Record<string, { instructionFile?: string }>,
  similarityThreshold: number = DEFAULT_PAIRWISE_DRIFT_THRESHOLD,
): ValidationResult {
  const absDir = resolve(repoRoot, relDir);
  const polarisFile = join(absDir, "POLARIS.md");
  const polarisRel = relative(repoRoot, polarisFile).replace(/\\/g, "/");

  if (!existsSync(polarisFile)) {
    return {
      dir: relDir,
      polarisFile: null,
      status: "MISSING",
      findings: [{ severity: "MISSING", message: `No POLARIS.md in ${relDir || "."}` }],
    };
  }

  const content = readFileSync(polarisFile, "utf-8");
  const findings: Finding[] = [];
  const polarisGenerated = extractGeneratedRegion(content) ?? content;

  // Signal 0: template-version stamp inside generated region
  const polarisStampFinding = checkTemplateVersionStamp(polarisGenerated, "POLARIS.md");
  if (polarisStampFinding) findings.push(polarisStampFinding);

  // Signal 1: ≥3 files in directory changed since last POLARIS.md git modification
  const lastMod = getLastGitModDate(polarisFile, repoRoot);
  if (lastMod !== null) {
    const changed = getFilesChangedAfter(absDir, lastMod, repoRoot);
    const relevant = changed.filter(
      (f) => !f.endsWith("POLARIS.md") && !f.endsWith("POLARIS.draft.md"),
    );
    if (relevant.length >= 3) {
      findings.push({
        severity: "WARN",
        message: `${relevant.length} files changed since last POLARIS.md update`,
      });
    }
  }

  // Signal 2: broken links in "Read before editing"
  const links = parseReadBeforeEditingLinks(polarisGenerated);
  for (const link of links) {
    const absLink = resolve(absDir, link);
    if (!existsSync(absLink)) {
      findings.push({
        severity: "ERROR",
        message: `Broken link in "Read before editing": ${link}`,
      });
    }
  }

  // Signal 3: instructionFile pointer in atlas references a non-existent path
  const normRelDir = relDir.replace(/\\/g, "/");
  for (const [filePath, entry] of Object.entries(allRoutes)) {
    const fileDir = dirname(filePath).replace(/\\/g, "/");
    if (fileDir !== normRelDir && !(normRelDir === "." && !filePath.includes("/"))) continue;
    if (!entry.instructionFile) continue;
    const absInstr = resolve(repoRoot, entry.instructionFile);
    if (!existsSync(absInstr)) {
      findings.push({
        severity: "ERROR",
        message: `Atlas entry "${filePath}" has instructionFile "${entry.instructionFile}" that does not exist`,
      });
    }
  }

  // Enforce POLARIS.md role boundaries (required and forbidden sections)
  const headingRe = /^##\s+(.+)$/gm;
  const parsedHeadings: { normalized: string; original: string }[] = [];
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingRe.exec(polarisGenerated)) !== null) {
    const original = headingMatch[1].trim();
    parsedHeadings.push({
      normalized: original.toLowerCase(),
      original,
    });
  }

  const requiredSections = [
    { key: "purpose", name: "Purpose" },
    { key: "what belongs here", alternative: "files", name: "What belongs here" },
    { key: "what does not belong here", name: "What does not belong here" },
    { key: "editing rules", name: "Editing rules" },
    { key: "architecture assumptions", name: "Architecture assumptions" },
    { key: "read before editing", name: "Read before editing" },
    { key: "related routes", name: "Related routes" },
  ];

  for (const section of requiredSections) {
    const hasSection = parsedHeadings.some(
      (h) => h.normalized === section.key || (section.alternative && h.normalized === section.alternative),
    );
    if (!hasSection) {
      findings.push({
        severity: "WARN",
        message: `Missing required section: "${section.name}"`,
      });
    }
  }

  for (const h of parsedHeadings) {
    if (h.normalized.includes("doctrine")) {
      findings.push({
        severity: "ERROR",
        message: `POLARIS.md must not contain doctrine (found section: "## ${h.original}")`,
      });
    }
    if (h.normalized.includes("spec") || h.normalized.includes("specification")) {
      if (!h.normalized.includes("read before editing") && !h.normalized.includes("nearby doc")) {
        findings.push({
          severity: "ERROR",
          message: `POLARIS.md must not contain architecture specs (found section: "## ${h.original}")`,
        });
      }
    }
    if (
      h.normalized.includes("history") ||
      h.normalized.includes("run summary") ||
      h.normalized.includes("run history") ||
      h.normalized.includes("session")
    ) {
      findings.push({
        severity: "ERROR",
        message: `POLARIS.md must not contain session history or run summaries (found section: "## ${h.original}")`,
      });
    }
  }

  // Signal 5: SUMMARY.md presence
  const summaryFile = join(absDir, "SUMMARY.md");
  if (!existsSync(summaryFile)) {
    // Only warn if the directory has >= 5 files in the atlas
    const atlasFiles = Object.keys(allRoutes).filter((filePath) => {
      const fileDir = dirname(filePath).replace(/\\/g, "/");
      return fileDir === normRelDir || (normRelDir === "." && !filePath.includes("/"));
    });
    if (atlasFiles.length >= 5) {
      findings.push({
        severity: "WARN",
        message: `Missing SUMMARY.md in ${relDir || "."}`,
      });
    }
  } else {
    // Signal 6: SUMMARY.md doctrine-bleed scan
    const summaryContent = readFileSync(summaryFile, "utf-8");
    const summaryGeneratedRaw = extractGeneratedRegion(summaryContent);
    const summaryGenerated = summaryGeneratedRaw ?? summaryContent;
    const summaryRel = relative(repoRoot, summaryFile).replace(/\\/g, "/");

    // Signal 5.5: SUMMARY.md template-version stamp (only inside generated region)
    if (summaryGeneratedRaw !== null) {
      const summaryStampFinding = checkTemplateVersionStamp(summaryGeneratedRaw, "SUMMARY.md");
      if (summaryStampFinding) findings.push(summaryStampFinding);
    }
    const modalVerbs = ["must", "never", "always"];
    const lines = summaryGenerated.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      for (const verb of modalVerbs) {
        if (new RegExp(`\\b${verb}\\b`, 'i').test(line)) {
          findings.push({
            severity: "ERROR",
            message: `SUMMARY.md doctrine bleed risk: found "${verb}" on line ${i + 1}`,
          });
        }
      }
    }

    // Signal 7: pairwise POLARIS.md / SUMMARY.md drift
    const routeName = relDir === "." ? undefined : basename(relDir);
    const similarity = computeNormalizedSimilarity(polarisGenerated, summaryGenerated, routeName);
    if (content === summaryContent) {
      findings.push({
        severity: "ERROR",
        message: `Route ${relDir || "."}: POLARIS.md and SUMMARY.md are exact duplicates (${polarisRel}, ${summaryRel})`,
      });
    } else if (similarity >= similarityThreshold) {
      findings.push({
        severity: "WARN",
        message: `Route ${relDir || "."}: POLARIS.md and SUMMARY.md normalized similarity ${similarity.toFixed(2)} exceeds threshold ${similarityThreshold} (${polarisRel}, ${summaryRel})`,
      });
    }
  }

  if (findings.length === 0) {
    return { dir: relDir, polarisFile: polarisRel, status: "OK", findings: [] };
  }

  const hasError = findings.some((f) => f.severity === "ERROR");
  return {
    dir: relDir,
    polarisFile: polarisRel,
    status: hasError ? "ERROR" : "WARN",
    findings,
  };
}

export interface ValidateInstructionsOptions {
  path?: string;
  fix?: boolean;
  repoRoot?: string;
  similarityThreshold?: number;
}

export interface ValidateInstructionsReport {
  results: ValidationResult[];
  hasErrors: boolean;
}

export function validateInstructions(
  opts: ValidateInstructionsOptions = {},
): ValidateInstructionsReport {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const config = loadConfig(repoRoot);
  const atlasPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
  const allRoutes = {
    ...readFileRoutes(atlasPath),
    ...readNeedsReview(atlasPath),
  };
  const requiredDirs = getRequiredDirs(repoRoot);

  let dirsToCheck: string[];
  if (opts.path) {
    const absPath = resolve(repoRoot, opts.path);
    const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");
    // Path traversal check
    if (relPath.startsWith("..") || relPath.startsWith("/")) {
      throw new Error(`Path traversal detected: path is outside repo root: ${opts.path}`);
    }
    dirsToCheck = [relPath];
  } else {
    // Include root dir and all eligible subdirs
    // Note: for validation, we include root and use default eligibility (skip agent folders, etc.)
    const { eligible: dirs } = collectDirs(repoRoot, repoRoot, {
      includeAgentFolders: false,
      includeHidden: false,
      skipRoot: true,
    });
    dirsToCheck = [".", ...dirs];
  }

  const threshold = opts.similarityThreshold ?? DEFAULT_PAIRWISE_DRIFT_THRESHOLD;

  const results: ValidationResult[] = [];
  for (const relDir of dirsToCheck) {
    const result = validateDir(relDir, repoRoot, allRoutes, threshold);
    // Upgrade MISSING → ERROR for required dirs
    if (result.status === "MISSING" && requiredDirs.includes(relDir)) {
      result.status = "ERROR";
    }
    results.push(result);
  }

  if (opts.fix) {
    for (const result of results) {
      if (result.status !== "OK") {
        const absDir = resolve(repoRoot, result.dir);
        const draftPath = join(absDir, "POLARIS.draft.md");
        // Path traversal check for draft path
        const relDraft = relative(repoRoot, draftPath);
        if (relDraft.startsWith("..") || relDraft.startsWith("/")) {
          result.findings.push({
            severity: "ERROR",
            message: "Cannot write draft: path traversal detected",
          });
          continue;
        }
        // Don't clobber existing drafts in fix mode
        if (existsSync(draftPath)) {
          result.findings.push({
            severity: "WARN",
            message: "Draft already exists at POLARIS.draft.md; skipping write",
          });
          continue;
        }
        const content = generateDraft(result.dir, repoRoot, allRoutes);
        writeFileSync(draftPath, content, "utf-8");
        result.findings.push({
          severity: "WARN",
          message: "Draft written to POLARIS.draft.md",
        });
      }
    }
  }

  const hasErrors = results.some((r) => r.status === "ERROR");
  return { results, hasErrors };
}

const DRAFT_WRITTEN_MSG = "Draft written to POLARIS.draft.md";

export function printReport(report: ValidateInstructionsReport): void {
  console.log("POLARIS.md validation report:");
  for (const result of report.results) {
    const label = result.polarisFile ?? `${result.dir || "."}/`;
    const statusPad = result.status.padEnd(7);
    console.log(`  ${label.padEnd(40)} ${statusPad}`);
    for (const finding of result.findings) {
      if (finding.message === DRAFT_WRITTEN_MSG) continue;
      const prefix = finding.severity === "ERROR" ? "ERROR:" : "WARN: ";
      console.log(`    ${prefix} ${finding.message}`);
    }
    const draftFinding = result.findings.find((f) => f.message === DRAFT_WRITTEN_MSG);
    if (draftFinding) {
      console.log(`    → Draft written to POLARIS.draft.md`);
    }
  }
}
