import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function hasPackageJson(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
    return pkg.name === "polaris";
  } catch {
    return false;
  }
}

function walkUp(startDir: string): string | null {
  let current = resolve(startDir);
  for (let i = 0; i < 20; i++) {
    if (hasPackageJson(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function resolveRepoRoot(): string {
  if (process.env["POLARIS_ROOT"]) {
    return resolve(process.env["POLARIS_ROOT"]);
  }

  const fromCwd = walkUp(process.cwd());
  if (fromCwd) return fromCwd;

  const fromModule = walkUp(dirname(__filename));
  if (fromModule) return fromModule;

  throw new Error(
    "Cannot locate Polaris repo root. Set POLARIS_ROOT env var or run from within the repo.",
  );
}
