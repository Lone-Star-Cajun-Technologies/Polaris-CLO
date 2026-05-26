import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Detects whether the Caveman compaction provider is available.
 *
 * Caveman is considered present when `.codex/skills/caveman/SKILL.md`
 * exists in the repository root.
 */
export function detectCaveman(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".codex", "skills", "caveman", "SKILL.md"));
}

/**
 * Detects whether the GitNexus compaction provider is available.
 *
 * GitNexus is considered present when the `gitnexus` executable is
 * found on PATH (equivalent to `which gitnexus` returning a hit).
 */
export function detectGitNexus(): boolean {
  try {
    execFileSync("which", ["gitnexus"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs all provider detections and returns the list of detected providers
 * as an array of strings.  Returns an empty array when none are detected.
 *
 * Recognised provider names: "caveman", "gitnexus".
 */
export function detectCompactionProviders(repoRoot: string): string[] {
  const detected: string[] = [];
  if (detectCaveman(repoRoot)) {
    detected.push("caveman");
  }
  if (detectGitNexus()) {
    detected.push("gitnexus");
  }
  return detected;
}
