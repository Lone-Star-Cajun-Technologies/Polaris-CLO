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
  "smartdocs/**",
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
