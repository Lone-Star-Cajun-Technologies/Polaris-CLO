import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { syncShims, type ShimDriftReport } from "../agent-plugin/sync.js";

export interface WorkspaceInstallResult {
  installed: string[];
  alreadyPresent: string[];
  skipped: string[];
  conflicted: string[];
  shimSync?: { written: string[]; drift: ShimDriftReport };
}

export type { ShimDriftReport };

export type GraphBuildStatus = "graph-success" | "graph-failed" | "graph-skipped";

export interface GraphBuildResult {
  status: GraphBuildStatus;
  stdout?: string;
  reason?: string;
  followUpCommand?: string;
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

/**
 * Recursively walk srcDir and install directories + .gitkeep files into dstDir.
 * parentWasPreExisting: true if dstDir already existed before Polaris touched it this run.
 * Skip .gitkeep if parentWasPreExisting (user already has content in that dir).
 */
function installSmartdocsDir(
  srcDir: string,
  dstDir: string,
  relPrefix: string,
  installed: string[],
  alreadyPresent: string[],
  parentWasPreExisting: boolean,
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcChild = join(srcDir, entry.name);
    const dstChild = join(dstDir, entry.name);
    const relChild = `${relPrefix}/${entry.name}`;

    if (entry.isDirectory()) {
      const childPreExisted = existsSync(dstChild);
      if (!childPreExisted) {
        mkdirSync(dstChild, { recursive: true });
        installed.push(relChild);
      }
      installSmartdocsDir(srcChild, dstChild, relChild, installed, alreadyPresent, childPreExisted);
    } else if (entry.name === ".gitkeep") {
      if (parentWasPreExisting) {
        alreadyPresent.push(relChild);
      } else {
        if (!existsSync(dstDir)) {
          mkdirSync(dstDir, { recursive: true });
        }
        installed.push(relChild);
      }
    }
  }
}

export function isThinPointer(content: string): boolean {
  // Split into lines
  const lines = content.split("\n");

  // Filter to meaningful lines (non-empty, non-whitespace, non-HTML-comment)
  const meaningfulLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Empty or whitespace-only
    if (!trimmed) return false;
    // HTML comment line (entire line is a comment)
    if (/^<!--.*-->$/.test(trimmed)) return false;
    return true;
  });

  // Rule 1: meaningful lines must be <= 3
  if (meaningfulLines.length > 3) return false;

  // Rule 2: at least one line must contain "POLARIS.md"
  const hasPolarisRef = meaningfulLines.some((line) => line.includes("POLARIS.md"));
  if (!hasPolarisRef) return false;

  return true;
}

export function installWorkspaceAssets(
  repoRoot: string,
  workspaceDir: string,
): WorkspaceInstallResult {
  const installed: string[] = [];
  const alreadyPresent: string[] = [];
  const skipped: string[] = [];
  const conflicted: string[] = [];

  // 1. Skills
  const srcSkillsDir = join(workspaceDir, ".polaris", "skills");
  const dstSkillsDir = join(repoRoot, ".polaris", "skills");
  if (existsSync(srcSkillsDir)) {
    for (const entry of readdirSync(srcSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relSkillDir = `.polaris/skills/${entry.name}`;
      if (isAncestorSymlink(repoRoot, relSkillDir)) {
        skipped.push(relSkillDir);
        continue;
      }
      const dstSkill = join(dstSkillsDir, entry.name);
      if (existsSync(dstSkill)) {
        alreadyPresent.push(relSkillDir);
        continue;
      }
      const srcSkill = join(srcSkillsDir, entry.name);
      mkdirSync(dstSkill, { recursive: true });
      for (const file of readdirSync(srcSkill, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        copyFileSync(join(srcSkill, file.name), join(dstSkill, file.name));
      }
      installed.push(relSkillDir);
    }
  }

  // 2. ROUTING.md
  const routingRel = ".polaris/skills/ROUTING.md";
  const srcRouting = join(workspaceDir, routingRel);
  const dstRouting = join(repoRoot, routingRel);
  if (existsSync(srcRouting)) {
    if (isAncestorSymlink(repoRoot, routingRel)) {
      skipped.push(routingRel);
    } else if (existsSync(dstRouting)) {
      alreadyPresent.push(routingRel);
    } else {
      mkdirSync(join(repoRoot, ".polaris", "skills"), { recursive: true });
      copyFileSync(srcRouting, dstRouting);
      installed.push(routingRel);
    }
  }

  // 3. Roles
  const srcRolesDir = join(workspaceDir, ".polaris", "roles");
  const dstRolesDir = join(repoRoot, ".polaris", "roles");
  if (existsSync(srcRolesDir)) {
    for (const entry of readdirSync(srcRolesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relFile = `.polaris/roles/${entry.name}`;
      if (isAncestorSymlink(repoRoot, relFile)) {
        skipped.push(relFile);
        continue;
      }
      const dstFile = join(dstRolesDir, entry.name);
      if (existsSync(dstFile)) {
        alreadyPresent.push(relFile);
        continue;
      }
      mkdirSync(dstRolesDir, { recursive: true });
      copyFileSync(join(srcRolesDir, entry.name), dstFile);
      installed.push(relFile);
    }
  }

  // 4. Smartdocs scaffold
  const srcSmartdocs = join(workspaceDir, "smartdocs");
  const dstSmartdocs = join(repoRoot, "smartdocs");
  if (existsSync(srcSmartdocs)) {
    const smartdocsPreExisted = existsSync(dstSmartdocs);
    installSmartdocsDir(srcSmartdocs, dstSmartdocs, "smartdocs", installed, alreadyPresent, smartdocsPreExisted);
  }

  // 5. POLARIS_RULES.md template
  const rulesRel = "POLARIS_RULES.md";
  const srcRules = join(workspaceDir, rulesRel);
  const dstRules = join(repoRoot, rulesRel);
  if (existsSync(srcRules)) {
    if (existsSync(dstRules)) {
      alreadyPresent.push(rulesRel);
    } else {
      copyFileSync(srcRules, dstRules);
      installed.push(rulesRel);
    }
  }

  // 6. Agent-plugin shims (Claude Code commands)
  const shimOutDir = join(repoRoot, ".claude", "commands");
  const shimSync = syncShims(shimOutDir);

  return { installed, alreadyPresent, skipped, conflicted, shimSync };
}

export function runGraphBuild(repoRoot: string): GraphBuildResult {
  try {
    const proc = spawnSync(process.execPath, [process.argv[1], "graph", "build"], {
      cwd: repoRoot,
      encoding: "buffer",
      timeout: 5 * 60 * 1000,
    });

    if (proc.status === 0) {
      return {
        status: "graph-success",
        stdout: proc.stdout ? proc.stdout.toString("utf-8") : undefined,
      };
    }

    return {
      status: "graph-failed",
      reason: proc.stderr ? proc.stderr.toString("utf-8") : "Unknown error",
      followUpCommand: "polaris-cli graph build",
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      status: "graph-failed",
      reason: errorMsg,
      followUpCommand: "polaris-cli graph build",
    };
  }
}
