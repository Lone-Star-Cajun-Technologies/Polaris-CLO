import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { readFileRoutes, readNeedsReview } from "../map/atlas.js";
import { generateDraft } from "./seed-instructions.js";

export type FindingSeverity = "OK" | "WARN" | "ERROR" | "MISSING";

export interface Finding {
  severity: Exclude<FindingSeverity, "OK">;
  message: string;
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

function getRequiredDirs(repoRoot: string): string[] {
  const config = loadConfig(repoRoot);
  // The config type may not yet have a docs key; access dynamically
  const docsConfig = (config as Record<string, unknown>)["docs"] as
    | { instructionFiles?: { required?: string[] } }
    | undefined;
  return docsConfig?.instructionFiles?.required ?? [];
}

function collectDirs(dir: string, root: string): string[] {
  const dirs: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "dist"
      ) {
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

/**
 * Validate a single directory's POLARIS.md.
 */
export function validateDir(
  relDir: string,
  repoRoot: string,
  allRoutes: Record<string, { instructionFile?: string }>,
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
  const links = parseReadBeforeEditingLinks(content);
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
    const relPath = relative(repoRoot, resolve(repoRoot, opts.path)).replace(/\\/g, "/");
    dirsToCheck = [relPath];
  } else {
    // Include root dir and all subdirs
    dirsToCheck = [".", ...collectDirs(repoRoot, repoRoot)];
  }

  const results: ValidationResult[] = [];
  for (const relDir of dirsToCheck) {
    const result = validateDir(relDir, repoRoot, allRoutes);
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
