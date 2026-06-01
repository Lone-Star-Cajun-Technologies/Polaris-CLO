import {
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
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
  /** Injected repo state detector function — for unit testing. */
  detectRepoState?: (repoRoot: string) => RepoState;
  /** Run existing repo adoption flow. */
  adopt?: boolean;
  /** Print detected repo state and exit without mutating files. */
  status?: boolean;
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
  /** Injected SmartDocs migration step — for unit testing. */
  applySmartDocsMigration?: (
    repoRoot: string,
    inventory: RepoScanInventory,
  ) => { moved: number; skipped: number };
  /** Injected timestamp for deterministic testing. */
  now?: Date;
}

export type RepoState = "empty" | "new" | "partial" | "existing" | "polaris-enabled";

const SOURCE_ROOT_HINTS = ["src", "lib", "app", "packages", "services", "server", "client"];
const DOC_ROOT_HINTS = [
  "docs",
  "doc",
  "wiki",
  "adr",
  "rfcs",
  "architecture",
  "design",
  "spec",
  "specs",
  "guides",
];
const MANIFEST_HINTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"];

function detectRepoState(repoRoot: string): RepoState {
  if (existsSync(join(repoRoot, ".polaris"))) {
    return "polaris-enabled";
  }

  let topLevelEntries: string[] = [];
  try {
    topLevelEntries = readdirSync(repoRoot);
  } catch {
    topLevelEntries = [];
  }

  const meaningfulEntries = topLevelEntries.filter((entry) => entry !== ".git" && entry !== ".gitignore");
  if (meaningfulEntries.length === 0) {
    return "empty";
  }

  const hasManifest = MANIFEST_HINTS.some((file) => existsSync(join(repoRoot, file)));
  const hasSourceRoots = topLevelEntries.some((entry) => SOURCE_ROOT_HINTS.includes(entry));
  const hasDocsRoots = topLevelEntries.some((entry) => DOC_ROOT_HINTS.includes(entry));

  if (hasManifest && !hasSourceRoots && !hasDocsRoots) {
    return "new";
  }

  if (!hasManifest && (hasSourceRoots || hasDocsRoots)) {
    return "partial";
  }

  return "existing";
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

function applySmartDocsMigration(
  repoRoot: string,
  inventory: RepoScanInventory,
): { moved: number; skipped: number } {
  let moved = 0;
  let skipped = 0;

  for (const candidate of inventory.smartdocs_candidates) {
    const sourcePath = join(repoRoot, candidate.path);
    const destinationPath = join(repoRoot, candidate.suggested_destination);

    if (!existsSync(sourcePath) || existsSync(destinationPath)) {
      skipped += 1;
      continue;
    }

    mkdirSync(dirname(destinationPath), { recursive: true });
    renameSync(sourcePath, destinationPath);
    moved += 1;
  }

  return { moved, skipped };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  const repoState = (options.detectRepoState ?? detectRepoState)(repoRoot);

  if (options.status) {
    process.stdout.write(`Repository state: ${repoState}\n`);
    return;
  }

  if (!options.adopt && repoState === "existing") {
    process.stdout.write(
      "This repo has existing content. Run `polaris init --adopt` to begin adoption.\n",
    );
    return;
  }

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
  const existingProviders = asRecord(existing.providers);

  const updatedProviders: Record<string, unknown> = { ...existingProviders };

  if (detected.length > 0) {
    updatedProviders.compactionProviders = detected;
  } else {
    // Omit the field entirely when no providers are detected.
    delete updatedProviders.compactionProviders;
  }

  const existingRepoAnalysis = asRecord(existingProviders.repoAnalysis);

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

  if (options.adopt) {
    const existingExecution = asRecord(existing.execution);
    updated.execution = {
      ...existingExecution,
      adapter: "terminal-cli",
      rotation: [],
      allowCrossAgentFallback: false,
    };

    const existingOrchestration = asRecord(existing.orchestration);
    updated.orchestration = {
      ...existingOrchestration,
      mode: "supervised",
    };
  }

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

  const migrationResult = (options.applySmartDocsMigration ?? applySmartDocsMigration)(
    repoRoot,
    inventory,
  );
  process.stdout.write(
    `SmartDocs migration step completed: moved ${migrationResult.moved}, skipped ${migrationResult.skipped}.\n`,
  );
  process.stdout.write("Adoption approved. Proceeding with mutation phases.\n");
}

/**
 * Registers the `init` subcommand on a Commander program.
 */
export function createInitCommand(options: InitOptions = {}): Command {
  const cmd = new Command("init")
    .description("initialise polaris.config.json and detect compaction providers")
    .option("--dry-run", "print generated config to stdout without writing")
    .option("--status", "detect and print current repository state without writing files")
    .option("--adopt", "run existing repository adoption flow")
    .option("--yes", "auto-approve adoption plan when used with --adopt")
    .action((cmdOptions: { dryRun?: boolean; status?: boolean; adopt?: boolean; yes?: boolean }) => {
      runInit({
        ...options,
        dryRun: cmdOptions.dryRun,
        status: cmdOptions.status,
        adopt: cmdOptions.adopt,
        yes: cmdOptions.yes,
      });
    });

  return cmd;
}
