import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Detects whether the Caveman compaction provider is available.
 *
 * Caveman is considered present when `.polaris/skills/caveman/SKILL.md`
 * exists in the repository root (canonical location). Falls back to
 * `.codex/skills/caveman/SKILL.md` for backwards compatibility.
 */
export function detectCaveman(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, ".polaris", "skills", "caveman", "SKILL.md")) ||
    existsSync(join(repoRoot, ".codex", "skills", "caveman", "SKILL.md"))
  );
}

/**
 * Detects whether the GitNexus compaction provider is available.
 *
 * GitNexus is considered present when the `gitnexus` executable is
 * found on PATH (cross-platform: uses `where` on Windows, `which` on Unix).
 */
export function detectGitNexus(): boolean {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    execFileSync(command, ["gitnexus"], { stdio: "ignore" });
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

/**
 * Runs repo-analysis provider detection and returns detected provider IDs.
 *
 * Recognised repo-analysis provider names: "gitnexus".
 */
export function detectRepoAnalysisProviders(): string[] {
  return detectGitNexus() ? ["gitnexus"] : [];
}
