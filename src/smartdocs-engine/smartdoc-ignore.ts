import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ignore from "ignore";

export const DEFAULT_SMARTDOCIGNORE_PATTERNS = [
  ".taskchain_artifacts/**",
  ".polaris/**",
  ".codex/**",
  ".claude/**",
  ".github/**",
  ".windsurf/**",
  ".agents/**",
  "smartdocs/docs/doctrine/**",
  "smartdocs/docs/specs/active/**",
  "smartdocs/docs/specs/implemented/**",
  "smartdocs/docs/specs/superseded/**",
  "smartdocs/docs/architecture/**",
  "smartdocs/docs/decisions/**",
  "smartdocs/docs/audits/**",
  "smartdocs/docs/runtime/**",
  "smartdocs/docs/integrations/**",
  "smartdocs/.obsidian/**",
  "generated/**",
  "**/generated/**",
  "summaries/**",
  "**/summaries/**",
  "README.md",
  "**/README.md",
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
  "GEMINI.md",
  "**/GEMINI.md",
  "POLARIS.md",
  "**/POLARIS.md",
  "SUMMARY.md",
  "**/SUMMARY.md",
];

export interface IngestEligibility {
  ineligible: boolean;
  reason?: string;
}

function toRepoRelativePath(filePath: string, repoRoot: string): string {
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(resolvedRoot, filePath);
  return relative(resolvedRoot, resolvedPath).replace(/\\/g, "/");
}

export function parseSmartDocIgnore(repoRoot: string): ReturnType<typeof ignore> {
  const ig = ignore();
  const ignorePath = resolve(repoRoot, ".smartdocignore");

  if (existsSync(ignorePath)) {
    ig.add(readFileSync(ignorePath, "utf-8"));
  }

  ig.add(DEFAULT_SMARTDOCIGNORE_PATTERNS);
  return ig;
}

export const parseSmarDocIgnore = parseSmartDocIgnore;

export function isIngestIneligible(filePath: string, repoRoot: string): IngestEligibility {
  const relPath = toRepoRelativePath(filePath, repoRoot);

  if (parseSmartDocIgnore(repoRoot).ignores(relPath)) {
    return {
      ineligible: true,
      reason: `ignored by .smartdocignore/defaults: ${relPath}`,
    };
  }

  return { ineligible: false };
}

/**
 * Runtime/build artifact directories that are permanently excluded from Smart Docs.
 * These are generated files, dependencies, or ephemeral runtime data.
 */
export const RUNTIME_EXCLUDED_DIR_PATTERNS = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".polaris",
  ".antigravitycli",
  ".taskchain_artifacts",
  "generated",
  "summaries",
  "test-output",
  "test_output",
  "test-results",
  "test_results",
  "fixtures",
  "fixture",
  "__snapshots__",
  "__fixtures__",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".netlify",
  ".cache",
  ".parcel-cache",
  ".webpack",
  ".rollup",
  ".vite",
  ".idea",
  ".vscode",
  ".nova",
];

/**
 * Agent/runtime cognition folders that are temporarily excluded by default.
 * These are not "junk" - they contain valid agent context, but are skipped
 * to avoid noise in default seeding. Can be included via --include-agent-folders.
 */
export const AGENT_COGNITION_FOLDERS = [
  ".codex",
  ".claude",
  ".agents",
];

/**
 * Other hidden/system folders that are excluded by default.
 * These are typically IDE/system folders, not agent cognition.
 */
export const HIDDEN_SYSTEM_FOLDERS = [
  ".github",
  ".windsurf",
];

export interface DirectoryEligibilityOptions {
  /** Include agent cognition folders (.codex, .claude, .agents) */
  includeAgentFolders?: boolean;
  /** Include hidden directories (starting with .) that aren't in runtime exclusions */
  includeHidden?: boolean;
  /** This is the root directory (special handling) */
  isRoot?: boolean;
  /** Skip root directory by default (root uses AGENTS.md/CLAUDE.md, not POLARIS.md) */
  skipRoot?: boolean;
}

export interface DirectoryEligibility {
  eligible: boolean;
  reason?: string;
  /** Category of exclusion for dry-run visibility */
  category?: "runtime" | "agent-cognition" | "hidden" | "ignored" | "root" | "eligible";
}

/**
 * Check if a directory is eligible for Smart Docs coverage.
 * Returns eligible: false for build artifacts, dependency folders, and ignored directories.
 */
export function isDirectoryEligible(
  dirPath: string,
  repoRoot: string,
  opts: DirectoryEligibilityOptions = {},
): DirectoryEligibility {
  const relPath = toRepoRelativePath(dirPath, repoRoot);
  const dirName = relPath.split("/").pop() || relPath;

  // Special handling for root directory
  if (opts.isRoot) {
    if (opts.skipRoot !== false) {
      return {
        eligible: false,
        reason: "root skipped by default (use AGENTS.md/CLAUDE.md for root behavior; use --include-root to override)",
        category: "root",
      };
    }
    return { eligible: true, category: "eligible" };
  }

  // Check against runtime/build artifact patterns (permanently excluded)
  for (const pattern of RUNTIME_EXCLUDED_DIR_PATTERNS) {
    // Check if directory name matches exactly
    if (dirName === pattern) {
      return {
        eligible: false,
        reason: `runtime artifact excluded: ${pattern}`,
        category: "runtime",
      };
    }
    // Check if any path segment matches
    if (relPath.includes(`/${pattern}/`) || relPath.startsWith(`${pattern}/`)) {
      return {
        eligible: false,
        reason: `runtime artifact excluded: ${pattern}`,
        category: "runtime",
      };
    }
  }

  // Check for agent cognition folders (temporarily excluded, can be opted-in)
  for (const pattern of AGENT_COGNITION_FOLDERS) {
    if (dirName === pattern || relPath.includes(`/${pattern}/`) || relPath.startsWith(`${pattern}/`)) {
      if (opts.includeAgentFolders) {
        return { eligible: true, category: "eligible" };
      }
      return {
        eligible: false,
        reason: `agent cognition folder temporarily skipped (use --include-agent-folders to include): ${pattern}`,
        category: "agent-cognition",
      };
    }
  }

  // Check for hidden system folders (excluded unless --include-hidden)
  for (const pattern of HIDDEN_SYSTEM_FOLDERS) {
    if (dirName === pattern || relPath.includes(`/${pattern}/`) || relPath.startsWith(`${pattern}/`)) {
      if (opts.includeHidden) {
        return { eligible: true, category: "eligible" };
      }
      return {
        eligible: false,
        reason: `hidden system folder (use --include-hidden to include): ${pattern}`,
        category: "hidden",
      };
    }
  }

  // Check if path is ignored by .smartdocignore
  // Note: ignore library requires trailing slash to match directories
  const ig = parseSmartDocIgnore(repoRoot);
  if (ig.ignores(relPath) || ig.ignores(`${relPath}/`)) {
    return {
      eligible: false,
      reason: `ignored by .smartdocignore: ${relPath}`,
      category: "ignored",
    };
  }

  // Other hidden directories (starting with .) are excluded
  if (dirName.startsWith(".")) {
    if (opts.includeHidden) {
      return { eligible: true, category: "eligible" };
    }
    return {
      eligible: false,
      reason: "hidden directory (use --include-hidden to include)",
      category: "hidden",
    };
  }

  return { eligible: true, category: "eligible" };
}
