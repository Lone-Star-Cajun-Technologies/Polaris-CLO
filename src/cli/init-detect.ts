import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type RepoState = "empty" | "new" | "partial" | "existing" | "polaris-enabled";

const SOURCE_ROOT_HINTS = ["src", "lib", "app", "packages", "services", "server", "client"];
const DOC_ROOT_HINTS = [
  "docs",
  "doc",
  "wiki",
  "adr",
  "rfcs",
  "architecture",
  "design",
  "spec",
  "specs",
  "guides",
];
const AGENT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "POLARIS.md", "SUMMARY.md"];

function safeReadDir(repoRoot: string): string[] {
  try {
    return readdirSync(repoRoot);
  } catch {
    return [];
  }
}

function hasAny(entries: readonly string[], values: readonly string[]): boolean {
  return entries.some((entry) => values.includes(entry));
}

function hasPolarisConfig(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "polaris.config.json"));
}

function hasFileRoutes(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".polaris", "map", "file-routes.json"));
}

export function detectRepoState(repoRoot: string): RepoState {
  const topLevelEntries = safeReadDir(repoRoot);
  const meaningfulEntries = topLevelEntries.filter((entry) => entry !== ".git");

  if (meaningfulEntries.length === 0) {
    return "empty";
  }

  const configExists = hasPolarisConfig(repoRoot);
  const fileRoutesExists = hasFileRoutes(repoRoot);

  if (configExists && fileRoutesExists) {
    return "polaris-enabled";
  }

  if (configExists) {
    return "partial";
  }

  const hasSourceRoots = hasAny(topLevelEntries, SOURCE_ROOT_HINTS);
  const hasDocsRoots = hasAny(topLevelEntries, DOC_ROOT_HINTS);
  const hasAgentInstructionFiles = hasAny(topLevelEntries, AGENT_INSTRUCTION_FILES);
  const hasPolarisConfigFile = existsSync(join(repoRoot, "polaris.config.json"));

  if (hasDocsRoots || hasAgentInstructionFiles || hasPolarisConfigFile) {
    return "existing";
  }

  if (existsSync(join(repoRoot, "package.json")) || hasSourceRoots) {
    return "new";
  }

  return "existing";
}
