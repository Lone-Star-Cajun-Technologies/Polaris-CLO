import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Command } from "commander";
import { detectCompactionProviders } from "../config/provider-detect.js";

export interface InitOptions {
  /** Absolute path to the repo root (defaults to cwd). */
  repoRoot?: string;
  /** If true, write output to stdout only (do not write the file). */
  dryRun?: boolean;
  /** Injected detector function — for unit testing. */
  detectProviders?: (repoRoot: string) => string[];
}

/**
 * Generates (or updates) `polaris.config.json` in the repo root.
 *
 * Provider detection:
 *   - Caveman: detected when `.codex/skills/caveman/SKILL.md` is present.
 *   - GitNexus: detected when `gitnexus` is on PATH.
 *
 * The `providers.compactionProviders` field is written only when at least
 * one provider is detected; it is omitted entirely otherwise.
 */
export function runInit(options: InitOptions = {}): void {
  const repoRoot = options.repoRoot ?? resolve(process.cwd());
  const configPath = join(repoRoot, "polaris.config.json");
  const detect = options.detectProviders ?? detectCompactionProviders;

  // Load existing config (if any) so we preserve user-authored fields.
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // Malformed JSON — start fresh rather than aborting.
      existing = {};
    }
  }

  const detected = detect(repoRoot);

  // Build updated providers section.
  const existingProviders =
    typeof existing.providers === "object" &&
    existing.providers !== null &&
    !Array.isArray(existing.providers)
      ? (existing.providers as Record<string, unknown>)
      : {};

  const updatedProviders: Record<string, unknown> = { ...existingProviders };

  if (detected.length > 0) {
    updatedProviders.compactionProviders = detected;
  } else {
    // Omit the field entirely when no providers are detected.
    delete updatedProviders.compactionProviders;
  }

  const updated: Record<string, unknown> = {
    ...existing,
    version: (existing.version as string | undefined) ?? "1.0",
  };

  if (Object.keys(updatedProviders).length > 0) {
    updated.providers = updatedProviders;
  } else if ("providers" in updated && Object.keys(updatedProviders).length === 0 && detected.length === 0) {
    // If existing providers had only compactionProviders and nothing else, clean it up.
    const remainingKeys = Object.keys(updatedProviders);
    if (remainingKeys.length === 0) {
      // Remove providers key if it is now empty.
      delete updated.providers;
    }
  }

  const json = JSON.stringify(updated, null, 2) + "\n";

  if (options.dryRun) {
    process.stdout.write(json);
    return;
  }

  writeFileSync(configPath, json, "utf-8");

  const providerSummary =
    detected.length > 0
      ? `Detected providers: ${detected.join(", ")}`
      : "No compaction providers detected";

  process.stdout.write(
    `polaris.config.json written to ${configPath}\n${providerSummary}\n`,
  );
}

/**
 * Registers the `init` subcommand on a Commander program.
 */
export function createInitCommand(options: InitOptions = {}): Command {
  // Lazy import to avoid pulling Commander into every module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Command } = require("commander") as typeof import("commander");

  const cmd = new Command("init")
    .description("initialise polaris.config.json and detect compaction providers")
    .option("--dry-run", "print generated config to stdout without writing")
    .action((cmdOptions: { dryRun?: boolean }) => {
      runInit({ ...options, dryRun: cmdOptions.dryRun });
    });

  return cmd;
}
