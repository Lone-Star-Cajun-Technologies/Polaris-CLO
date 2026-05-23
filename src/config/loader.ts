import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PolarisConfig } from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { validateConfig } from "./validator.js";

export class PolarisConfigError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
  ) {
    super(message);
    this.name = "PolarisConfigError";
  }
}

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as T;
  for (const key of Object.keys(source) as Array<keyof T>) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      typeof srcVal === "object" &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      ) as T[typeof key];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[typeof key];
    }
  }
  return result;
}

export function loadConfig(repoRoot: string): Required<PolarisConfig> {
  const configPath = resolve(repoRoot, "polaris.config.json");

  let userConfig: Partial<PolarisConfig> = {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    userConfig = JSON.parse(raw) as Partial<PolarisConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PolarisConfigError(
        `Failed to read polaris.config.json: ${(err as Error).message}`,
        [],
      );
    }
  }

  const validation = validateConfig(userConfig);
  if (!validation.valid) {
    throw new PolarisConfigError(
      `Invalid polaris.config.json:\n${validation.errors.join("\n")}`,
      validation.errors,
    );
  }

  return deepMerge(DEFAULT_CONFIG, userConfig) as Required<PolarisConfig>;
}
