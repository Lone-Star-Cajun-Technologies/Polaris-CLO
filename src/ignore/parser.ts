import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ignore from "ignore";
import { DEFAULT_EXCLUSIONS, SECRET_PATTERNS } from "./defaults.js";

export function parsePolarisIgnore(userPatterns: string[]): ReturnType<typeof ignore> {
  const ig = ignore();
  // User patterns first so SECRET_PATTERNS applied after cannot be negated
  ig.add(userPatterns);
  ig.add(DEFAULT_EXCLUSIONS);
  ig.add(SECRET_PATTERNS);
  return ig;
}

export function isIgnored(filePath: string, repoRoot: string): boolean {
  const ig = ignore();
  ig.add(DEFAULT_EXCLUSIONS);

  const ignorePath = resolve(repoRoot, ".polarisignore");
  try {
    const raw = readFileSync(ignorePath, "utf-8");
    const userPatterns = raw.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("#"));

    // Apply non-secret user patterns first
    const nonSecretPatterns = userPatterns.filter((p) => !SECRET_PATTERNS.includes(p));
    ig.add(nonSecretPatterns);

    // Re-add secret patterns so they cannot be negated
    ig.add(SECRET_PATTERNS);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code !== "ENOENT") {
      throw err;
    }
  }

  return ig.ignores(filePath);
}
