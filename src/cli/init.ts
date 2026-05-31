import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Command } from "commander";
import {
  detectCompactionProviders,
  detectRepoAnalysisProviders,
} from "../config/provider-detect.js";
import {
  generateAdoptionPlanArtifacts,
  type AdoptionPlanArtifacts,
  type RepoScanInventory,
} from "./adoption-plan.js";
import { scanAdoptionInventory as scanRepoAdoptionInventory } from "./adoption-inventory.js";

export interface InitOptions {
  /** Absolute path to the repo root (defaults to cwd). */
  repoRoot?: string;
  /** If true, write output to stdout only (do not write the file). */
  dryRun?: boolean;
  /** Injected compaction detector function — for unit testing. */
  detectProviders?: (repoRoot: string) => string[];
  /** Injected repo-analysis detector function — for unit testing. */
  detectRepoAnalysisProviders?: (repoRoot: string) => string[];
  /** Run existing repo adoption flow. */
  adopt?: boolean;
  /** Auto-approve adoption plan prompt (for CI). */
  yes?: boolean;
  /** Injected adoption inventory scanner — for unit testing. */
  scanAdoptionInventory?: (repoRoot: string) => RepoScanInventory;
  /** Injected adoption plan generator — for unit testing. */
  generateAdoptionArtifacts?: (
    repoRoot: string,
    inventory: RepoScanInventory,
    options: { dryRun?: boolean; now?: Date },
  ) => AdoptionPlanArtifacts;
  /** Injected approval reader — for unit testing. */
  readAdoptionApproval?: () => boolean;
  /** Injected timestamp for deterministic testing. */
  now?: Date;
}

function promptAdoptionApproval(): boolean {
  process.stdout.write("Approve adoption plan and continue? [y/N] ");
  try {
    const response = readFileSync(0, "utf-8").trim().toLowerCase();
    return response === "y" || response === "yes";
  } catch {
    return false;
  }
}

/**
 * Generates (or updates) `polaris.config.json` in the repo root.
 *
 * Compaction provider detection:
 *   - Caveman: detected when `.polaris/skills/caveman/SKILL.md` is present (falls back to `.codex/skills/caveman/SKILL.md`).
 *   - GitNexus: detected when `gitnexus` is on PATH.
 *
 * The `providers.compactionProviders` field is written only when at least
 * one provider is detected; it is omitted entirely otherwise.
 *
 * Repo-analysis provider detection writes `providers.repoAnalysis.preferred`
 * only when an external provider is detected.
 */
export function runInit(options: InitOptions = {}): void {
  const repoRoot = options.repoRoot ?? resolve(process.cwd());
  const configPath = join(repoRoot, "polaris.config.json");
  const detectCompaction = options.detectProviders ?? detectCompactionProviders;
  const detectRepoAnalysis = options.detectRepoAnalysisProviders ?? detectRepoAnalysisProviders;

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

  const detected = detectCompaction(repoRoot);
  const detectedRepoAnalysis = detectRepoAnalysis(repoRoot);

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

  const existingRepoAnalysis =
    typeof existingProviders.repoAnalysis === "object" &&
    existingProviders.repoAnalysis !== null &&
    !Array.isArray(existingProviders.repoAnalysis)
      ? (existingProviders.repoAnalysis as Record<string, unknown>)
      : {};

  const updatedRepoAnalysis: Record<string, unknown> =
    detectedRepoAnalysis.length > 0
      ? { ...existingRepoAnalysis, preferred: detectedRepoAnalysis[0] }
      : Object.fromEntries(
          Object.entries(existingRepoAnalysis).filter(([key]) => key !== "preferred"),
        );

  if (Object.keys(updatedRepoAnalysis).length > 0) {
    updatedProviders.repoAnalysis = updatedRepoAnalysis;
  } else {
    delete updatedProviders.repoAnalysis;
  }

  const updated: Record<string, unknown> = {
    ...existing,
    version: typeof existing.version === "string" ? existing.version : "1.0",
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

  if (!options.adopt) {
    return;
  }

  const now = options.now ?? new Date();
  const scanAdoptionInventory =
    options.scanAdoptionInventory ?? ((root: string) => scanRepoAdoptionInventory(root, { now }));
  const inventory = scanAdoptionInventory(repoRoot);
  const adoptionArtifacts = (options.generateAdoptionArtifacts ?? generateAdoptionPlanArtifacts)(
    repoRoot,
    inventory,
    { dryRun: options.dryRun, now },
  );

  process.stdout.write(`${adoptionArtifacts.markdown}\n`);

  const approved = options.yes ? true : (options.readAdoptionApproval ?? promptAdoptionApproval)();
  if (!approved) {
    process.stdout.write("Adoption aborted: explicit approval required.\n");
    return;
  }

  process.stdout.write("Adoption approved. Proceeding with mutation phases.\n");
}

/**
 * Registers the `init` subcommand on a Commander program.
 */
export function createInitCommand(options: InitOptions = {}): Command {
  const cmd = new Command("init")
    .description("initialise polaris.config.json and detect compaction providers")
    .option("--dry-run", "print generated config to stdout without writing")
    .option("--adopt", "run existing repository adoption flow")
    .option("--yes", "auto-approve adoption plan when used with --adopt")
    .action((cmdOptions: { dryRun?: boolean; adopt?: boolean; yes?: boolean }) => {
      runInit({
        ...options,
        dryRun: cmdOptions.dryRun,
        adopt: cmdOptions.adopt,
        yes: cmdOptions.yes,
      });
    });

  return cmd;
}
