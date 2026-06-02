import {
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { Command } from "commander";
import {
  detectCompactionProviders,
  detectRepoAnalysisProviders,
} from "../config/provider-detect.js";
import {
  generateAdoptionPlanArtifacts,
  type AdoptionPlan,
  type AdoptionPlanArtifacts,
  type RepoScanInventory,
} from "./adoption-plan.js";
import { scanAdoptionInventory as scanRepoAdoptionInventory } from "./adoption-inventory.js";
import { generateFolderCognition as generateRepoFolderCognition } from "./adopt-cognition.js";
import { migrateSmartDocs } from "./adopt-smartdocs.js";
import { runMapIndex } from "../map/index.js";
import { handleInstructionFiles } from "./adopt-instructions.js";

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
  /** Stage and commit adoption output (when used with --adopt). */
  commit?: boolean;
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
  /** Injected folder cognition generation step — for unit testing. */
  generateFolderCognition?: (plan: AdoptionPlan, inventory: RepoScanInventory) => Promise<void>;
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
const RUNTIME_ARTIFACT_EXCLUSIONS = [
  ".polaris/runs/",
  ".polaris/bootstrap/",
  ".polaris/clusters/",
  ".polaris/session-type",
] as const;

const RUNTIME_ARTIFACT_IGNORE_BLOCK = [
  "# Polaris runtime artifacts — do not commit",
  ...RUNTIME_ARTIFACT_EXCLUSIONS,
].join("\n");

const PLAN_COMPLETE_STATUSES = new Set(["completed", "skipped"]);
const ADOPTION_LOCKED_EXECUTION = {
  rotation: [],
  allowCrossAgentFallback: false,
  adapter: "terminal-cli",
} as const;
const ADOPTION_LOCKED_ORCHESTRATION = {
  mode: "supervised",
} as const;

interface FinalizeAdoptionOptions {
  repoRoot?: string;
  commit?: boolean;
  now?: Date;
  commitMessage?: string;
}

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

function isAdoptionConfigLocked(existing: Record<string, unknown>): boolean {
  const execution = asRecord(existing.execution);
  const orchestration = asRecord(existing.orchestration);

  return (
    Array.isArray(execution.rotation) &&
    execution.rotation.length === 0 &&
    execution.allowCrossAgentFallback === false &&
    execution.adapter === ADOPTION_LOCKED_EXECUTION.adapter &&
    orchestration.mode === ADOPTION_LOCKED_ORCHESTRATION.mode
  );
}

function buildInitConfig(
  existing: Record<string, unknown>,
  detected: string[],
  detectedRepoAnalysis: string[],
  adopt: boolean,
): Record<string, unknown> {
  const existingProviders = asRecord(existing.providers);
  const updatedProviders: Record<string, unknown> = { ...existingProviders };

  if (detected.length > 0) {
    updatedProviders.compactionProviders = detected;
  } else {
    delete updatedProviders.compactionProviders;
  }

  const existingRepoAnalysis = asRecord(existingProviders.repoAnalysis);
  const updatedRepoAnalysis: Record<string, unknown> =
    detectedRepoAnalysis.length > 0
      ? { ...existingRepoAnalysis, preferred: detectedRepoAnalysis[0] }
      : Object.fromEntries(
          Object.entries(existingRepoAnalysis).filter(([key]) => key !== "preferred"),
        );

  const updated: Record<string, unknown> = {
    ...existing,
    version: typeof existing.version === "string" ? existing.version : "1.0",
  };

  if (adopt) {
    const existingExecution = asRecord(existing.execution);
    updated.execution = {
      ...existingExecution,
      ...ADOPTION_LOCKED_EXECUTION,
    };

    const existingOrchestration = asRecord(existing.orchestration);
    updated.orchestration = {
      ...existingOrchestration,
      ...ADOPTION_LOCKED_ORCHESTRATION,
    };
  }

  if (Object.keys(updatedProviders).length > 0) {
    updated.providers = updatedProviders;
  } else if ("providers" in updated && Object.keys(updatedProviders).length === 0 && detected.length === 0) {
    delete updated.providers;
  }

  if (Object.keys(updatedRepoAnalysis).length > 0) {
    updatedProviders.repoAnalysis = updatedRepoAnalysis;
    updated.providers = updatedProviders;
  } else if (updated.providers) {
    const providers = asRecord(updated.providers);
    delete providers.repoAnalysis;
    if (Object.keys(providers).length > 0) {
      updated.providers = providers;
    } else {
      delete updated.providers;
    }
  }

  return updated;
}

function writeAdoptionConfigLock(
  repoRoot: string,
  configPath: string,
  existing: Record<string, unknown>,
  detected: string[],
  detectedRepoAnalysis: string[],
): boolean {
  if (isAdoptionConfigLocked(existing)) {
    process.stdout.write("Provider config already locked — skipping.\n");
    return false;
  }

  const updated = buildInitConfig(existing, detected, detectedRepoAnalysis, true);
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  process.stdout.write(`polaris.config.json written to ${configPath}\n`);
  return true;
}

function areAllPlanStepsComplete(plan: AdoptionPlanArtifacts["plan"]): boolean {
  return plan.steps.length > 0 && plan.steps.every((step) => PLAN_COMPLETE_STATUSES.has(step.status));
}

function ensureRuntimeArtifactExclusions(repoRoot: string): void {
  const gitignorePath = join(repoRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const lines = existing.split(/\r?\n/);
  const missing = [RUNTIME_ARTIFACT_IGNORE_BLOCK].filter((block) => {
    const required = block.split("\n");
    return !required.every((line) => lines.includes(line));
  });

  if (missing.length === 0) {
    return;
  }

  const trimmed = existing.trimEnd();
  const separator = trimmed.length > 0 ? "\n\n" : "";
  const next = `${trimmed}${separator}${missing.join("\n")}\n`;
  writeFileSync(gitignorePath, next, "utf-8");
}

function readBaselineCoverage(repoRoot: string): string {
  const mapIndexPath = join(repoRoot, ".polaris", "map", "index.json");
  if (!existsSync(mapIndexPath)) {
    return "n/a";
  }

  try {
    const parsed = JSON.parse(readFileSync(mapIndexPath, "utf-8")) as Record<string, unknown>;
    const baseline = parsed.adoption_baseline_coverage_pct;
    if (typeof baseline === "number") {
      return `${baseline}%`;
    }
    const coverage = parsed.coverage_pct;
    if (typeof coverage === "number") {
      return `${coverage}%`;
    }
  } catch {
    return "n/a";
  }

  return "n/a";
}

export function runAdoptionAtlas(plan: AdoptionPlan): Promise<void>;
export function runAdoptionAtlas(plan: AdoptionPlan, repoRoot: string): Promise<void>;
export function runAdoptionAtlas(plan: AdoptionPlan, repoRoot = resolve(process.cwd())): Promise<void> {
  if (!plan.steps.some((step) => step.category === "atlas-generate")) {
    return Promise.resolve();
  }

  try {
    runMapIndex(repoRoot, false, false, { seedCognition: false, skipThreshold: true });

    const mapDir = join(repoRoot, ".polaris", "map");
    const indexPath = join(mapDir, "index.json");
    if (!existsSync(indexPath)) {
      throw new Error("Adoption atlas generation did not produce .polaris/map/index.json");
    }

    const atlasIndex = asRecord(JSON.parse(readFileSync(indexPath, "utf-8")));
    const entries = asRecord(atlasIndex.entries);
    const hasSmartDocsRawEntry = Object.keys(entries).some((filePath) =>
      filePath.startsWith("smartdocs/raw/"),
    );
    if (!hasSmartDocsRawEntry) {
      throw new Error("Adoption atlas validation failed: no smartdocs/raw/ entries found in atlas");
    }

    const needsReviewPath = join(mapDir, "needs-review.json");
    const needsReviewEntries = existsSync(needsReviewPath)
      ? asRecord(JSON.parse(readFileSync(needsReviewPath, "utf-8")))
      : {};

    const totalFiles =
      typeof atlasIndex.file_count === "number"
        ? atlasIndex.file_count
        : Object.keys(entries).length;
    const needsReviewCount = Object.keys(needsReviewEntries).length;
    const needsReviewPct = totalFiles > 0 ? (needsReviewCount / totalFiles) * 100 : 0;
    if (needsReviewPct > 20) {
      process.stdout.write(
        `[WARN] Adoption atlas needs-review debt is ${needsReviewPct.toFixed(1)}% (${needsReviewCount}/${totalFiles}); continuing.\n`,
      );
    }

    const baselineCoverage =
      typeof atlasIndex.coverage_pct === "number" ? atlasIndex.coverage_pct : 0;
    writeFileSync(
      indexPath,
      `${JSON.stringify(
        {
          ...atlasIndex,
          adoption_baseline_coverage_pct: baselineCoverage,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

function updatePlanForFinalization(
  repoRoot: string,
  plan: AdoptionPlanArtifacts["plan"],
  now: Date,
): AdoptionPlanArtifacts["plan"] {
  const completedAt = now.toISOString();
  const updatedPlan = {
    ...plan,
    approved: true,
    approved_at: plan.approved_at ?? completedAt,
    steps: plan.steps.map((step) =>
      PLAN_COMPLETE_STATUSES.has(step.status)
        ? step
        : {
            ...step,
            status: "completed" as const,
            completed_at: completedAt,
            error: undefined,
          },
    ),
  };

  writeFileSync(
    join(repoRoot, ".polaris", "adoption-plan.json"),
    `${JSON.stringify(updatedPlan, null, 2)}\n`,
    "utf-8",
  );

  return updatedPlan;
}

function stageAdoptionOutputs(repoRoot: string, plan: AdoptionPlanArtifacts["plan"]): void {
  const stagePaths = new Set<string>([
    ".polaris/adoption-plan.json",
    ".polaris/adoption-inventory.json",
    ".polaris/adoption-provenance.json",
    "polaris.config.json",
    ".polaris/map",
    "POLARIS.md",
    "SUMMARY.md",
    ".gitignore",
  ]);

  for (const step of plan.steps) {
    if (step.source_path) {
      stagePaths.add(step.source_path);
    }
    if (step.dest_path) {
      stagePaths.add(step.dest_path);
    }
  }

  execFileSync("git", ["add", "-A", "--", ...stagePaths], { cwd: repoRoot, stdio: "pipe" });
}

function unstageRuntimeArtifacts(repoRoot: string): void {
  const stagedPaths = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: repoRoot,
    encoding: "utf-8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const blocked = stagedPaths.filter((path) =>
    RUNTIME_ARTIFACT_EXCLUSIONS.some(
      (excluded) => path === excluded.replace(/\/$/, "") || path.startsWith(excluded),
    ),
  );

  if (blocked.length === 0) {
    return;
  }

  execFileSync("git", ["restore", "--staged", "--", ...blocked], { cwd: repoRoot, stdio: "pipe" });
}

function createAdoptionCommitMessage(plan: AdoptionPlanArtifacts["plan"]): string {
  const moved = plan.impact_summary.smartdocs_candidates_moved;
  const cognition = plan.impact_summary.cognition_files_to_generate;
  return `chore: adopt Polaris init — ${moved} files moved, ${cognition} cognition files generated`;
}

function printAdoptionSummary(repoRoot: string, plan: AdoptionPlanArtifacts["plan"]): void {
  const baselineCoverage = readBaselineCoverage(repoRoot);
  process.stdout.write(
    `Adoption summary: moved=${plan.impact_summary.smartdocs_candidates_moved}, cognition=${plan.impact_summary.cognition_files_to_generate}, instruction_files=${plan.impact_summary.instruction_files_affected}, baseline_coverage=${baselineCoverage}, excluded_runtime_paths=${RUNTIME_ARTIFACT_EXCLUSIONS.join(", ")}\n`,
  );
}

export function finalizeAdoption(plan: AdoptionPlanArtifacts["plan"]): Promise<void>;
export function finalizeAdoption(
  plan: AdoptionPlanArtifacts["plan"],
  options: FinalizeAdoptionOptions,
): Promise<void>;
export function finalizeAdoption(
  plan: AdoptionPlanArtifacts["plan"],
  options: FinalizeAdoptionOptions = {},
): Promise<void> {
  if (areAllPlanStepsComplete(plan)) {
    process.stdout.write("Adoption already complete.\n");
    return Promise.resolve();
  }

  const repoRoot = options.repoRoot ?? resolve(process.cwd());
  ensureRuntimeArtifactExclusions(repoRoot);
  return runAdoptionAtlas(plan, repoRoot).then(() => {
    const updatedPlan = updatePlanForFinalization(repoRoot, plan, options.now ?? new Date());
    stageAdoptionOutputs(repoRoot, updatedPlan);
    unstageRuntimeArtifacts(repoRoot);
    printAdoptionSummary(repoRoot, updatedPlan);

    if (options.commit) {
      const message = options.commitMessage ?? createAdoptionCommitMessage(updatedPlan);
      execFileSync("git", ["commit", "-m", message], { cwd: repoRoot, stdio: "pipe" });
      process.stdout.write(`Adoption commit created: ${message}\n`);
    } else {
      process.stdout.write(
        "Adoption changes staged. Review with `git diff --cached` and commit when ready.\n",
      );
    }
  });
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

  const updated = buildInitConfig(existing, detected, detectedRepoAnalysis, Boolean(options.adopt));

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }

  if (options.adopt) {
    writeAdoptionConfigLock(repoRoot, configPath, existing, detected, detectedRepoAnalysis);
  } else {
    writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
    const providerSummary =
      detected.length > 0
        ? `Detected providers: ${detected.join(", ")}`
        : "No compaction providers detected";
    process.stdout.write(
      `polaris.config.json written to ${configPath}\n${providerSummary}\n`,
    );
  }

  if (!options.adopt) {
    return;
  }

  const adoptionPlanPath = join(repoRoot, ".polaris", "adoption-plan.json");
  if (existsSync(adoptionPlanPath)) {
    try {
      const existingPlan = JSON.parse(readFileSync(adoptionPlanPath, "utf-8")) as AdoptionPlanArtifacts["plan"];
      if (areAllPlanStepsComplete(existingPlan)) {
        process.stdout.write("Adoption already complete.\n");
        return;
      }
    } catch {
      // Fall through and regenerate adoption artifacts.
    }
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

  const smartDocsMigrationSteps = adoptionArtifacts.plan.steps.filter(
    (step) => step.category === "smartdocs-migrate",
  );

  if (smartDocsMigrationSteps.length > 0) {
    migrateSmartDocs(adoptionArtifacts.plan, repoRoot);
    const moved = adoptionArtifacts.plan.steps.filter(
      (step) => step.category === "smartdocs-migrate" && step.status === "completed",
    ).length;
    const skipped = adoptionArtifacts.plan.steps.filter(
      (step) => step.category === "smartdocs-migrate" && step.status === "skipped",
    ).length;
    process.stdout.write(
      `SmartDocs migration step completed: moved ${moved}, skipped ${skipped}.\n`,
    );
  } else {
    const migrationResult = (options.applySmartDocsMigration ?? applySmartDocsMigration)(
      repoRoot,
      inventory,
    );
    process.stdout.write(
      `SmartDocs migration step completed: moved ${migrationResult.moved}, skipped ${migrationResult.skipped}.\n`,
    );
  }
  void (options.generateFolderCognition ?? generateRepoFolderCognition)(
    adoptionArtifacts.plan,
    inventory,
  );
  process.stdout.write("Folder cognition generation step completed.\n");
  handleInstructionFiles(adoptionArtifacts.plan, inventory);
  process.stdout.write("Instruction file handling step completed.\n");
  if (adoptionArtifacts.plan.steps.some((step) => step.category === "stage")) {
    finalizeAdoption(adoptionArtifacts.plan, {
      repoRoot,
      commit: options.commit,
      now,
    });
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
    .option("--status", "detect and print current repository state without writing files")
    .option("--adopt", "run existing repository adoption flow")
    .option("--yes", "auto-approve adoption plan when used with --adopt")
    .option("--commit", "create an adoption commit when used with --adopt")
    .action((cmdOptions: { dryRun?: boolean; status?: boolean; adopt?: boolean; yes?: boolean; commit?: boolean }) => {
      runInit({
        ...options,
        dryRun: cmdOptions.dryRun,
        status: cmdOptions.status,
        adopt: cmdOptions.adopt,
        yes: cmdOptions.yes,
        commit: cmdOptions.commit,
      });
    });

  return cmd;
}
