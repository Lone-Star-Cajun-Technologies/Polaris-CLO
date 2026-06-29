/**
 * Dev gate: autoresearch commands are only allowed inside a Polaris development context.
 *
 * "Polaris dev context" = the working directory or one of its ancestors contains a
 * `package.json` whose `name` field equals `"@lsctech/polaris"`.
 *
 * This is intentionally narrow: it must match the monorepo where Polaris is developed,
 * not arbitrary consumer repos that happen to depend on it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findPackageJson(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = dirname(dir); // stop at filesystem root
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
  return null;
}

export function isPolarisDevContext(startDir = process.cwd()): boolean {
  const pkgPath = findPackageJson(startDir);
  if (!pkgPath) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    return pkg["name"] === "@lsctech/polaris";
  } catch {
    return false;
  }
}

/**
 * Throws if not in a Polaris dev context.
 * Call this at the start of any dev-gated command.
 */
export function assertPolarisDevContext(startDir?: string): void {
  if (!isPolarisDevContext(startDir)) {
    throw new Error(
      "polaris autoresearch score is a dev-only command and can only run inside the Polaris development repository.\n" +
        "It is not available in consumer repos.",
    );
  }
}
