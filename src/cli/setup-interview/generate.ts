import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AdoptionPlan, RepoScanInventory, SmartDocsCandidate } from "../adoption-plan.js";
import { promptApproval, type PromptApprovalOptions } from "../adopt-approve.js";
import { generatePolarisRules as defaultGeneratePolarisRules } from "../adopt-rules.js";
import { migrateSmartDocs as defaultMigrateSmartDocs } from "../adopt-smartdocs.js";
import { scaffoldRootSurfaces as defaultScaffoldRootSurfaces } from "../adopt-workspace.js";
import { runMapIndex as defaultRunMapIndex } from "../../map/index.js";
import type { InterviewRecord } from "./schema.js";
import { markApproved, saveInterview } from "./store.js";

export interface GenerateSetupArtifactsOptions {
  /** Absolute path to the repo root. */
  repoRoot?: string;
  /** If true, print the plan without writing files. */
  dryRun?: boolean;
  /** If true, skip the interactive approval prompt. */
  yes?: boolean;
  /** Current timestamp — for deterministic tests. */
  now?: Date;
  /** Override stdin for testing. */
  stdin?: Readable;
  /** Override stdout for testing. */
  stdout?: Writable;
  /** Compaction providers detected by init. */
  detectedProviders?: string[];
  /** Repo-analysis providers detected by init. */
  detectedRepoAnalysis?: string[];
  /** Injected root surface scaffolding — for testing. */
  scaffoldRootSurfaces?: (repoRoot: string) => { created: string[]; skipped: string[] };
  /** Injected POLARIS_RULES.md generator — for testing. */
  generatePolarisRules?: typeof defaultGeneratePolarisRules;
  /** Injected SmartDocs migration — for testing. */
  migrateSmartDocs?: typeof defaultMigrateSmartDocs;
  /** Injected map index runner — for testing. */
  runMapIndex?: typeof defaultRunMapIndex;
  /** Injected approval prompt — for testing. */
  promptApproval?: (plan: AdoptionPlan, options: PromptApprovalOptions) => Promise<boolean>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildSetupConfig(
  existing: Record<string, unknown>,
  record: InterviewRecord,
  detectedProviders: string[],
  detectedRepoAnalysis: string[],
): Record<string, unknown> {
  const updated: Record<string, unknown> = {
    ...existing,
    version: typeof existing.version === "string" ? existing.version : "1.0",
  };

  const providers: Record<string, unknown> = {};
  const existingProviders = asRecord(existing.providers);

  if (detectedProviders.length > 0) {
    providers.compactionProviders = detectedProviders;
  } else if (existingProviders.compactionProviders) {
    providers.compactionProviders = existingProviders.compactionProviders;
  }

  if (detectedRepoAnalysis.length > 0) {
    const existingRepoAnalysis = asRecord(existingProviders.repoAnalysis);
    providers.repoAnalysis = { ...existingRepoAnalysis, preferred: detectedRepoAnalysis[0] };
  } else if (existingProviders.repoAnalysis) {
    providers.repoAnalysis = existingProviders.repoAnalysis;
  }

  if (Object.keys(providers).length > 0) {
    updated.providers = { ...existingProviders, ...providers };
  }

  const existingRepo = asRecord(existing.repo);
  updated.repo = {
    ...existingRepo,
    sourceRoots: record.answers.source_roots,
    docsRoots: record.answers.canonical_doc_folders,
  };

  const providersByRole = record.answers.providers_by_role;
  if (providersByRole && Object.keys(providersByRole).length > 0) {
    const existingExecution = asRecord(existing.execution);
    const existingExecutionProviders = asRecord(existingExecution.providers);
    const executionProviders: Record<string, unknown> = { ...existingExecutionProviders };
    for (const [role, provider] of Object.entries(providersByRole)) {
      executionProviders[role] = { command: provider };
    }
    updated.execution = {
      ...existingExecution,
      providers: executionProviders,
    };
  }

  return updated;
}

function buildSetupInventory(record: InterviewRecord): RepoScanInventory {
  const candidates: SmartDocsCandidate[] = (record.answers.canonical_doc_folders ?? []).map(
    (folder) => ({
      path: folder,
      kind: "doc" as const,
      suggested_destination: `smartdocs/raw/${folder}`,
      confidence: 0.9,
      has_frontmatter: false,
      estimated_risk: "low" as const,
    }),
  );

  return {
    scan_date: new Date().toISOString(),
    repo_state: "new",
    package_manager: null,
    source_roots: record.answers.source_roots ?? [],
    docs_roots: record.answers.canonical_doc_folders ?? [],
    test_commands: [],
    build_commands: [],
    package_scripts: {},
    generated_roots: [],
    cache_roots: [],
    fixture_roots: [],
    agent_instruction_files: [],
    existing_smartdocs_dirs: [],
    architecture_notes: [record.answers.project_purpose ?? ""].filter(Boolean),
    likely_canonical_folders: record.answers.canonical_doc_folders ?? [],
    smartdocs_candidates: candidates,
    ignore_candidates: record.answers.never_touch ?? [],
  };
}

function* walkMarkdownFiles(dir: string, root: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(full, root);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield relative(root, full).replace(/\\/g, "/");
    }
  }
}

function scanCanonicalDocs(repoRoot: string, folders: string[]): SmartDocsCandidate[] {
  const candidates: SmartDocsCandidate[] = [];
  for (const folder of folders) {
    const absFolder = join(repoRoot, folder);
    if (!existsSync(absFolder)) continue;
    for (const relPath of walkMarkdownFiles(absFolder, repoRoot)) {
      candidates.push({
        path: relPath,
        kind: "doc",
        suggested_destination: `smartdocs/raw/${relPath}`,
        confidence: 0.9,
        has_frontmatter: false,
        estimated_risk: "low",
      });
    }
  }
  return candidates;
}

function buildSetupPlan(record: InterviewRecord, repoRoot: string, now: Date): AdoptionPlan {
  const candidates = scanCanonicalDocs(repoRoot, record.answers.canonical_doc_folders ?? []);
  const steps: AdoptionPlan["steps"] = [];
  let order = 1;

  steps.push({
    step_id: "setup-genesis",
    order: order++,
    phase: "A",
    category: "scaffold",
    action: "create",
    dest_path: "GENESIS.md",
    description: "Write initial project genesis from interview answers.",
    destructive: false,
    requires_approval: false,
    estimated_risk: "low",
    status: "pending",
  });

  steps.push({
    step_id: "setup-config",
    order: order++,
    phase: "A",
    category: "provider-config",
    action: "modify",
    dest_path: "polaris.config.json",
    description: "Write polaris.config.json from interview answers and detected providers.",
    destructive: true,
    requires_approval: false,
    estimated_risk: "low",
    status: "pending",
  });

  steps.push({
    step_id: "setup-rules",
    order: order++,
    phase: "A",
    category: "scaffold",
    action: "create",
    dest_path: "POLARIS_RULES.md",
    description: "Generate Polaris rules from interview answers.",
    destructive: false,
    requires_approval: false,
    estimated_risk: "low",
    status: "pending",
  });

  steps.push({
    step_id: "setup-root-surfaces",
    order: order++,
    phase: "A",
    category: "scaffold",
    action: "create",
    dest_path: "POLARIS.md, SUMMARY.md, CLAUDE.md, AGENTS.md, .github/copilot-instructions.md",
    description: "Create root route surfaces if missing.",
    destructive: false,
    requires_approval: false,
    estimated_risk: "low",
    status: "pending",
  });

  for (const candidate of candidates) {
    steps.push({
      step_id: `setup-smartdocs-migrate-${order.toString().padStart(3, "0")}`,
      order: order++,
      phase: "C",
      category: "smartdocs-migrate",
      action: "move",
      source_path: candidate.path,
      dest_path: candidate.suggested_destination,
      description: `Move ${candidate.path} to ${candidate.suggested_destination}.`,
      destructive: true,
      requires_approval: true,
      estimated_risk: "low",
      status: "pending",
    });
  }

  steps.push({
    step_id: "setup-atlas-generate",
    order: order++,
    phase: "C",
    category: "atlas-generate",
    action: "modify",
    dest_path: ".polaris/map/index.json",
    description: "Run polaris map index to generate initial route atlas.",
    destructive: true,
    requires_approval: true,
    estimated_risk: "medium",
    status: "pending",
  });

  const filesToCreate = steps.filter((s) => s.action === "create").length;
  const filesToMove = steps.filter((s) => s.action === "move").length;
  const filesToModify = steps.filter((s) => s.action === "modify" || s.action === "append").length;

  return {
    plan_id: `setup-${now.toISOString().replaceAll(":", "-")}`,
    generated_at: now.toISOString(),
    repo_state: "new",
    approved: false,
    approved_at: null,
    dry_run: false,
    steps,
    impact_summary: {
      files_to_create: filesToCreate,
      files_to_move: filesToMove,
      files_to_modify: filesToModify,
      instruction_files_affected: 0,
      smartdocs_candidates_moved: candidates.length,
      cognition_files_to_generate: 0,
    },
  };
}

function renderSetupPlanMarkdown(record: InterviewRecord, plan: AdoptionPlan): string {
  const a = record.answers;
  const scaffoldSteps = plan.steps.filter((s) => s.category === "scaffold" && s.action === "create");
  const scaffoldPaths = scaffoldSteps.map((s) => s.dest_path).join(", ");
  const lines: string[] = [
    "# Setup Plan",
    "",
    `**Project purpose:** ${a.project_purpose ?? "(not specified)"}`,
    "",
    `**Source roots:** ${(a.source_roots ?? []).join(", ") || "(none)"}`,
    "",
    `**Languages / frameworks:** ${(a.languages ?? []).join(", ") || "(none)"}`,
    "",
    `**Canonical documentation folders:** ${(a.canonical_doc_folders ?? []).join(", ") || "(none)"}`,
    "",
    `**Never touch:** ${(a.never_touch ?? []).join(", ") || "(none)"}`,
    "",
    `**Providers by role:** ${Object.entries(a.providers_by_role ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ") || "(none)"}`,
    "",
    "## Files to generate",
    "",
    `- GENESIS.md`,
    `- polaris.config.json`,
    `- POLARIS_RULES.md`,
    ...scaffoldPaths.split(", ").map((p) => `- ${p.trim()}`),
    "",
    "## SmartDocs intake",
    "",
    `Markdown files in canonical documentation folders will be migrated to smartdocs/raw/ (${plan.impact_summary.smartdocs_candidates_moved} candidates).`,
    "",
    `**Operations:** ${plan.steps.length} steps (${plan.impact_summary.files_to_create} create, ${plan.impact_summary.files_to_move} move, ${plan.impact_summary.files_to_modify} modify).`,
  ];
  return lines.join("\n");
}

function buildGenesisContent(record: InterviewRecord): string {
  const a = record.answers;
  return [
    "# Genesis",
    "",
    "> Initial project genesis generated by Polaris setup.",
    "",
    "## Purpose",
    "",
    a.project_purpose ?? "",
    "",
    "## Source Roots",
    "",
    ...(a.source_roots ?? []).length > 0
      ? (a.source_roots ?? []).map((root) => `- ${root}`)
      : ["- (none)"],
    "",
    "## Languages / Frameworks",
    "",
    ...(a.languages ?? []).length > 0
      ? (a.languages ?? []).map((lang) => `- ${lang}`)
      : ["- (none)"],
    "",
    "## Canonical Documentation Folders",
    "",
    ...(a.canonical_doc_folders ?? []).length > 0
      ? (a.canonical_doc_folders ?? []).map((folder) => `- ${folder}`)
      : ["- (none)"],
    "",
    "## Governance",
    "",
    "- POLARIS_RULES.md — Polaris routing and governance rules",
    "- POLARIS.md — operational guidance",
    "- SUMMARY.md — informational context",
    "",
  ].join("\n");
}

function writeGenesis(repoRoot: string, record: InterviewRecord): void {
  const genesisPath = join(repoRoot, "GENESIS.md");
  if (existsSync(genesisPath)) return;
  writeFileSync(genesisPath, buildGenesisContent(record), "utf-8");
}

function writeSetupConfig(
  repoRoot: string,
  record: InterviewRecord,
  detectedProviders: string[],
  detectedRepoAnalysis: string[],
): void {
  const configPath = join(repoRoot, "polaris.config.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const updated = buildSetupConfig(existing, record, detectedProviders, detectedRepoAnalysis);
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}

/**
 * Generate setup artifacts from a completed interview record.
 *
 * - Builds a preview plan from the interview answers.
 * - In dry-run mode, prints the plan and returns without writing.
 * - With --yes, bypasses the approval prompt.
 * - Otherwise prompts the operator for approval.
 * - On approval, writes GENESIS.md, polaris.config.json, POLARIS_RULES.md,
 *   root route surfaces, migrates SmartDocs candidates, and runs the map index.
 */
export async function generateSetupArtifacts(
  record: InterviewRecord,
  options: GenerateSetupArtifactsOptions = {},
): Promise<void> {
  const repoRoot = options.repoRoot ?? resolve(process.cwd());
  const dryRun = options.dryRun ?? false;
  const yes = options.yes ?? false;
  const now = options.now ?? new Date();
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const detectedProviders = options.detectedProviders ?? [];
  const detectedRepoAnalysis = options.detectedRepoAnalysis ?? [];

  const scaffoldFn = options.scaffoldRootSurfaces ?? defaultScaffoldRootSurfaces;
  const rulesFn = options.generatePolarisRules ?? defaultGeneratePolarisRules;
  const migrateFn = options.migrateSmartDocs ?? defaultMigrateSmartDocs;
  const mapFn = options.runMapIndex ?? defaultRunMapIndex;
  const promptFn = options.promptApproval ?? promptApproval;

  const plan = buildSetupPlan(record, repoRoot, now);
  const markdown = renderSetupPlanMarkdown(record, plan);

  if (dryRun) {
    stdout.write(`${markdown}\n\n`);
    stdout.write("Setup dry run: no files written.\n");
    return;
  }

  let approved = false;
  if (yes) {
    stdout.write(`${markdown}\n\n`);
    stdout.write("Setup approval bypassed via --yes.\n");
    approved = true;
  } else {
    approved = await promptFn(plan, {
      repoRoot,
      stdin,
      stdout,
      now,
      markdown,
      persist: (_plan, root, approvalNow) => {
        const approvedRecord = markApproved(record, approvalNow);
        saveInterview(root, approvedRecord);
      },
    });
  }

  if (!approved) {
    stdout.write("Setup aborted: explicit approval required.\n");
    return;
  }

  writeGenesis(repoRoot, record);
  writeSetupConfig(repoRoot, record, detectedProviders, detectedRepoAnalysis);
  await rulesFn(repoRoot, buildSetupInventory(record), {
    workspaceDir: resolve(__dirname, "../../workspace"),
  });
  scaffoldFn(repoRoot);
  await migrateFn(plan, repoRoot);
  mapFn(repoRoot, false, false, { seedCognition: false, skipThreshold: true });

  stdout.write("Setup generation complete.\n");
}
