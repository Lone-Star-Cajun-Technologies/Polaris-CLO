import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface RootSurfaceResult {
  created: string[];
  skipped: string[];
}

interface SurfaceSpec {
  relPath: string;
  content: string;
}

function isAncestorSymlink(repoRoot: string, relPath: string): boolean {
  const parts = relPath.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const ancestor = resolve(repoRoot, ...parts.slice(0, i + 1));
    try {
      const stat = lstatSync(ancestor);
      if (stat.isSymbolicLink()) return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
  return false;
}

function buildRootPolarisDraft(): string {
  return [
    "<!-- polaris:draft -->",
    "# Repository",
    "",
    "> Polaris draft — review and remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    "## Purpose",
    "",
    "<!-- One paragraph describing what this repository does. -->",
    "",
    "**Domain:** unknown",
    "**Route:** /",
    "**Taskchain:** unknown",
    "",
    "## What belongs here",
    "",
    "<!-- Describe the top-level assets and responsibilities. -->",
    "",
    "## What does not belong here",
    "",
    "<!-- Describe content that should be routed elsewhere. -->",
    "",
    "## Polaris Rules",
    "",
    "See [POLARIS_RULES.md](POLARIS_RULES.md) for canonical Polaris navigation and routing rules.",
    "",
  ].join("\n");
}

function buildRootSummaryDraft(): string {
  return [
    "<!-- polaris:draft -->",
    "# Summary — Repository Root",
    "",
    "> Polaris draft — review and remove the `<!-- polaris:draft -->` marker to promote.",
    "",
    "- Route: `/`",
    "- Canon status: draft",
    "- Linked doctrine: `POLARIS.md`",
    "",
    "## Notes",
    "",
    "<!-- Add concise context, references, and ownership details. -->",
    "",
  ].join("\n");
}

function buildAgentPointer(): string {
  return [
    "# Agent Instructions",
    "",
    "This repository is managed by Polaris.",
    "Read [POLARIS.md](POLARIS.md) before beginning any work.",
    "",
  ].join("\n");
}

function buildCopilotPointer(): string {
  return [
    "# Copilot Instructions",
    "",
    "This repository is managed by Polaris.",
    "Read [POLARIS.md](../../POLARIS.md) before beginning any work.",
    "",
  ].join("\n");
}

export function scaffoldRootSurfaces(repoRoot: string): RootSurfaceResult {
  const surfaces: SurfaceSpec[] = [
    { relPath: "POLARIS.md", content: buildRootPolarisDraft() },
    { relPath: "SUMMARY.md", content: buildRootSummaryDraft() },
    { relPath: "CLAUDE.md", content: buildAgentPointer() },
    { relPath: "AGENTS.md", content: buildAgentPointer() },
    { relPath: ".github/copilot-instructions.md", content: buildCopilotPointer() },
  ];

  const created: string[] = [];
  const skipped: string[] = [];

  for (const { relPath, content } of surfaces) {
    if (isAncestorSymlink(repoRoot, relPath)) {
      process.stderr.write(`Skipping root surface inside symlinked path: ${relPath}\n`);
      skipped.push(relPath);
      continue;
    }

    const absPath = join(repoRoot, relPath);
    if (existsSync(absPath)) {
      skipped.push(relPath);
      continue;
    }

    const dir = dirname(absPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, "utf-8");
    created.push(relPath);
  }

  return { created, skipped };
}
