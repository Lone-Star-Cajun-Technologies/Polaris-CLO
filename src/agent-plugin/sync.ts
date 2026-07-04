import * as fs from "fs";
import * as path from "path";
import { SLASH_COMMANDS } from "./commands.js";
import { generateAllClaudeShims, SHIM_VERSION } from "./claude-generator.js";
import { generateAllCodexPluginSkills } from "./codex-generator.js";

/**
 * Workspace sync and versioning for generated agent-plugin shims.
 *
 * Responsibilities:
 * 1. Detect drift between on-disk shims and the current SLASH_COMMANDS manifest
 *    / ROUTING.md (stale version stamps, missing files, orphaned files).
 * 2. Regenerate and re-stamp all shims when called.
 * 3. Integrate with the asset-install path (called from adopt-assets.ts).
 */

/** Pattern used to read the version stamp from a shim file. */
const VERSION_STAMP_RE = /<!--\s*polaris-shim-version:\s*(\S+)\s*-->/;

export interface ShimDriftReport {
  /** Shims whose on-disk version stamp differs from SHIM_VERSION. */
  stale: string[];
  /** Verb names in SLASH_COMMANDS that have no on-disk shim file. */
  missing: string[];
  /** Shim files on disk that have no matching entry in SLASH_COMMANDS. */
  orphaned: string[];
  /** True when stale, missing, or orphaned is non-empty. */
  hasDrift: boolean;
}

/**
 * Inspect `outDir` and return a drift report comparing on-disk shims against
 * the current SLASH_COMMANDS manifest and SHIM_VERSION.
 */
export function detectShimDrift(outDir: string = ".claude/commands"): ShimDriftReport {
  const stale: string[] = [];
  const missing: string[] = [];
  const orphaned: string[] = [];

  const expectedNames = new Set(SLASH_COMMANDS.map((c) => `${c.name}.md`));

  // Check each manifest command against the on-disk file
  for (const command of SLASH_COMMANDS) {
    const filePath = path.join(outDir, `${command.name}.md`);
    if (!fs.existsSync(filePath)) {
      missing.push(command.name);
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const match = VERSION_STAMP_RE.exec(content);
    if (!match || match[1] !== SHIM_VERSION) {
      stale.push(command.name);
    }
  }

  // Check for orphaned shim files (on disk but not in manifest)
  if (fs.existsSync(outDir)) {
    for (const entry of fs.readdirSync(outDir)) {
      if (!entry.endsWith(".md")) continue;
      if (!expectedNames.has(entry)) {
        orphaned.push(entry.replace(/\.md$/, ""));
      }
    }
  }

  return {
    stale,
    missing,
    orphaned,
    hasDrift: stale.length > 0 || missing.length > 0 || orphaned.length > 0,
  };
}

export interface SyncResult {
  written: string[];
  drift: ShimDriftReport;
}

/**
 * Regenerate all shims and return what was written plus the prior drift state.
 *
 * This is the primary entry point for both `polaris agent-plugin sync` and
 * the adopt-assets install step.
 */
export function syncShims(outDir: string = ".claude/commands"): SyncResult {
  const drift = detectShimDrift(outDir);
  const written = generateAllClaudeShims(outDir);
  for (const name of drift.orphaned) {
    const orphanPath = path.join(outDir, `${name}.md`);
    if (fs.existsSync(orphanPath)) {
      fs.rmSync(orphanPath);
    }
  }
  return { written, drift };
}

export interface CodexPluginSyncResult {
  written: string[];
}

export function syncCodexPluginSkills(
  outDir: string = ".codex/plugins/polaris/skills",
): CodexPluginSyncResult {
  return { written: generateAllCodexPluginSkills(outDir) };
}
