import {
  writeFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { Command } from "commander";
import { detectRepoState, type RepoState } from "./init-detect.js";
import {
  detectCompactionProviders,
  detectRepoAnalysisProviders,
} from "../config/provider-detect.js";
import {
  generateAdoptionPlanArtifacts,
  type AdoptionPlan,
  type AdoptionPlanArtifacts,
  type RepoScanInventory,
  renderAdoptionPlanMarkdown,
} from "./adoption-plan.js";
import {
  logAdoptionApprovalTelemetry,
  persistApprovedAdoptionPlan,
  promptApproval,
} from "./adopt-approve.js";
import { scanRepo as scanRepoAdoptionInventory } from "./adopt-scan.js";
import { generateFolderCognition as generateRepoFolderCognition } from "./adopt-cognition.js";
import { migrateSmartDocs } from "./adopt-smartdocs.js";
import { runMapIndex } from "../map/index.js";
import { handleInstructionFiles } from "./adopt-instructions.js";
import { scaffoldRootSurfaces as defaultScaffoldRootSurfaces } from "./adopt-workspace.js";
import {
  formatGitignoreBlock,
  isPathBlockedFromStaging,
} from "../finalize/artifact-policy.js";

export { detectRepoState } from "./init-detect.js";
export type { RepoState } from "./init-detect.js";

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
  /** Resume an approved adoption plan without re-prompting. */
  resume?: boolean;
  /** Print detected repo state and exit without mutating files. */
  status?: boolean;
  /** Auto-approve adoption plan prompt (for CI). */
  yes?: boolean;
  /** Stage and commit adoption output (when used with --adopt). */
  commit?: boolean;
  /** Injected adoption inventory scanner — for unit testing. */
  scanAdoptionInventory?: (repoRoot: string) => RepoScanInventory | Promise<RepoScanInventory>;
  /** Allow overwriting an existing adoption inventory artifact. */
  rescan?: boolean;
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
  generateFolderCognition?: (plan: AdoptionPlan, inventory: RepoScanInventory, repoRoot: string) => Promise<void>;
  /** Injected root workspace surface scaffolding — for unit testing. */
  scaffoldRootSurfaces?: (repoRoot: string) => { created: string[]; skipped: string[] };
  /** Injected finalizeAdoption — for unit testing. */
  finalizeAdoption?: (plan: AdoptionPlanArtifacts["plan"], options: { repoRoot: string; commit?: boolean; now?: Date }) => Promise<void>;
  /** Injected timestamp for deterministic testing. */
  now?: Date;
}

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

function loadAdoptionPlanArtifacts(repoRoot: string): AdoptionPlanArtifacts | null {
  const jsonPath = join(repoRoot, ".polaris", "adoption-plan.json");
  const markdownPath = join(repoRoot, ".polaris", "adoption-plan.md");

  if (!existsSync(jsonPath)) {
    return null;
  }

  try {
    const json = readFileSync(jsonPath, "utf-8");
    const plan = JSON.parse(json) as AdoptionPlanArtifacts["plan"];
    const markdown = existsSync(markdownPath)
      ? readFileSync(markdownPath, "utf-8")
      : renderAdoptionPlanMarkdown(plan);
    return {
      plan,
      json,
      markdown,
      jsonPath,
      markdownPath,
      wroteFiles: false,
    };
  } catch {
    return null;
  }
}

function ensureRuntimeArtifactExclusions(repoRoot: string): void {
  const gitignorePath = join(repoRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const lines = existing.split(/\r?\n/);
  const ignoreBlock = formatGitignoreBlock();
  const required = ignoreBlock.split("\n");
  const missing = !required.every((line) => lines.includes(line));

  if (!missing) {
    return;
  }

  const trimmed = existing.trimEnd();
  const separator = trimmed.length > 0 ? "\n\n" : "";
  const next = `${trimmed}${separator}${ignoreBlock}\n`;
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

/**
 * Returns true if any ancestor of relPath (from repoRoot) is a symlink.
 * Prevents git from rejecting pathspecs that are "beyond a symbolic link".
 */
export function isBeyondSymlink(repoRoot: string, relPath: string): boolean {
  const parts = relPath.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const ancestor = resolve(repoRoot, ...parts.slice(0, i + 1));
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        return true;
      }
    } catch {
      // ancestor doesn't exist — can't be a symlink
      return false;
    }
  }
  return false;
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
    "CLAUDE.md",
    "AGENTS.md",
    ".github/copilot-instructions.md",
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

  const validPaths: string[] = [];
  for (const p of stagePaths) {
    if (!existsSync(resolve(repoRoot, p))) {
      continue;
    }
    if (isBeyondSymlink(repoRoot, p)) {
      process.stderr.write(`Skipping adoption output inside symlinked path: ${p}\n`);
      continue;
    }
    validPaths.push(p);
  }

  if (validPaths.length > 0) {
    execFileSync("git", ["add", "-A", "--", ...validPaths], { cwd: repoRoot, stdio: "pipe" });
  }
}

function unstageRuntimeArtifacts(repoRoot: string): void {
  const stagedPaths = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: repoRoot,
    encoding: "utf-8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const blocked = stagedPaths.filter((path) => isPathBlockedFromStaging(path));

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
    `Adoption summary: moved=${plan.impact_summary.smartdocs_candidates_moved}, cognition=${plan.impact_summary.cognition_files_to_generate}, instruction_files=${plan.impact_summary.instruction_files_affected}, baseline_coverage=${baselineCoverage}\n`,
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
export async function runInit(options: InitOptions = {}): Promise<void> {
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
      "This repo has existing content. Run `polaris init --adopt` to begin adoption.\nThis repo has existing content. Run polaris init --adopt to begin adoption.\n",
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

  if (options.dryRun && !options.adopt) {
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }

  if (options.adopt) {
    if (!options.dryRun) {
      writeAdoptionConfigLock(repoRoot, configPath, existing, detected, detectedRepoAnalysis);
      // Phase A: scaffold root surfaces before inventory scan so doctrineExists check in
      // instruction reconciliation sees POLARIS.md at runtime.
      const scaffoldFn = options.scaffoldRootSurfaces ?? defaultScaffoldRootSurfaces;
      const scaffoldResult = scaffoldFn(repoRoot);
      if (scaffoldResult.created.length > 0) {
        process.stdout.write(`Root surfaces created: ${scaffoldResult.created.join(", ")}\n`);
      }
    }
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
    options.scanAdoptionInventory ??
    ((root: string) => scanRepoAdoptionInventory(root, { now, rescan: options.rescan }));
  const inventoryResult = scanAdoptionInventory(repoRoot);
  let inventory: RepoScanInventory;
  if (inventoryResult && typeof (inventoryResult as Promise<RepoScanInventory>).then === "function") {
    inventory = await inventoryResult;
  } else {
    inventory = inventoryResult as RepoScanInventory;
  }
  const loadedArtifacts = options.resume ? loadAdoptionPlanArtifacts(repoRoot) : null;
  const adoptionArtifacts =
   loadedArtifacts ?? (options.generateAdoptionArtifacts ?? generateAdoptionPlanArtifacts)(
     repoRoot,
     inventory,
     { dryRun: options.dryRun, now },
   );

  if (options.dryRun) {
   process.stdout.write(`${adoptionArtifacts.markdown}\n`);
   process.stdout.write("Adoption dry run: Phase C writes skipped.\n");
   return;
  }

  let approved = false;
  if (options.yes) {
   process.stdout.write(`${adoptionArtifacts.markdown}\n`);
   persistApprovedAdoptionPlan(adoptionArtifacts.plan, repoRoot, now);
   logAdoptionApprovalTelemetry(repoRoot, {
     event: "adoption-approval-bypassed",
     run_mode: "yes",
     plan_id: adoptionArtifacts.plan.plan_id,
     timestamp: now.toISOString(),
   });
   process.stdout.write("Adoption approval bypassed via --yes.\n");
   approved = true;
  } else if (options.resume && adoptionArtifacts.plan.approved) {
   process.stdout.write(`${adoptionArtifacts.markdown}\n`);
   if (!adoptionArtifacts.plan.approved_at) {
     persistApprovedAdoptionPlan(adoptionArtifacts.plan, repoRoot, now);
   }
   approved = true;
  } else if (options.readAdoptionApproval) {
   process.stdout.write(`${adoptionArtifacts.markdown}\n`);
   approved = options.readAdoptionApproval();
   if (approved) {
     persistApprovedAdoptionPlan(adoptionArtifacts.plan, repoRoot, now);
   } else {
     process.stdout.write("Adoption aborted: explicit approval required.\n");
     return;
   }
  } else {
   approved = await promptApproval(adoptionArtifacts.plan, { repoRoot, now });
   if (!approved) {
     return;
   }
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
    repoRoot,
  );
  process.stdout.write("Folder cognition generation step completed.\n");
  handleInstructionFiles(adoptionArtifacts.plan, inventory, repoRoot);
  process.stdout.write("Instruction file handling step completed.\n");
  const finalizeAdoptionFn = options.finalizeAdoption ?? finalizeAdoption;
  if (adoptionArtifacts.plan.steps.some((step) => step.category === "stage")) {
    await finalizeAdoptionFn(adoptionArtifacts.plan, {
      repoRoot,
      commit: options.commit,
      now,
    });
    return;
  }

  // No stage step — stage inline so adoption is always committed/staged
  stageAdoptionOutputs(repoRoot, adoptionArtifacts.plan);
  unstageRuntimeArtifacts(repoRoot);
  printAdoptionSummary(repoRoot, adoptionArtifacts.plan);
  if (options.commit) {
    const message = createAdoptionCommitMessage(adoptionArtifacts.plan);
    execFileSync("git", ["commit", "-m", message], { cwd: repoRoot, stdio: "pipe" });
    process.stdout.write(`Adoption commit created: ${message}\n`);
  } else {
    process.stdout.write("Adoption changes staged. Review with `git diff --cached` and commit when ready.\n");
  }
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
    .option("--resume", "resume an approved adoption plan without prompting")
    .option("--yes", "auto-approve adoption plan when used with --adopt")
    .option("--commit", "create an adoption commit when used with --adopt")
    .action(async (cmdOptions: { dryRun?: boolean; status?: boolean; adopt?: boolean; resume?: boolean; yes?: boolean; commit?: boolean }) => {
      await runInit({
        ...options,
        dryRun: cmdOptions.dryRun,
        status: cmdOptions.status,
        adopt: cmdOptions.adopt,
        resume: cmdOptions.resume,
        yes: cmdOptions.yes,
        commit: cmdOptions.commit,
      });
    });

  return cmd;
}
