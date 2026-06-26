import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorContext } from "./adoption-context.js";

export interface AgentInstructionFile {
  path: string;
  provider: "claude" | "openai" | "copilot" | "cursor" | "gemini" | "aider" | "unknown";
  size_bytes: number;
  has_polaris_delegation: boolean;
  recommendation: "preserve" | "migrate" | "thin-adapter";
  reason: string;
}

export interface SmartDocsCandidate {
  path: string;
  kind: "doc" | "spec" | "decision" | "architecture" | "integration" | "unknown";
  suggested_destination: string;
  confidence: number;
  has_frontmatter: boolean;
  estimated_risk: "low" | "medium" | "high";
}

export interface RepoScanInventory {
  scan_date: string;
  repo_state: "empty" | "new" | "partial" | "existing" | "polaris-enabled";
  package_manager: "npm" | "yarn" | "pnpm" | "bun" | null;
  source_roots: string[];
  docs_roots: string[];
  test_commands: string[];
  build_commands: string[];
  package_scripts: Record<string, string>;
  generated_roots: string[];
  cache_roots: string[];
  fixture_roots: string[];
  agent_instruction_files: AgentInstructionFile[];
  existing_smartdocs_dirs: string[];
  architecture_notes: string[];
  likely_canonical_folders: string[];
  smartdocs_candidates: SmartDocsCandidate[];
  ignore_candidates: string[];
}

export type DocRouting = "raw" | "candidate" | "hold" | "review-required";

export interface AdoptionStep {
  step_id: string;
  order: number;
  phase: "A" | "B" | "C";
  category:
    | "provider-config"
    | "scaffold"
    | "smartdocs-migrate"
    | "cognition-generate"
    | "instruction-refactor"
    | "atlas-generate"
    | "ignore-rules"
    | "stage";
  action: "create" | "move" | "modify" | "skip" | "append";
  source_path?: string;
  dest_path?: string;
  description: string;
  destructive: boolean;
  requires_approval: boolean;
  estimated_risk: "low" | "medium" | "high";
  status: "pending" | "completed" | "skipped" | "failed";
  completed_at?: string;
  error?: string;
  evidence_refs?: string[];
  operator_refs?: string[];
  routing?: DocRouting;
}

export interface AdoptionImpact {
  files_to_create: number;
  files_to_move: number;
  files_to_modify: number;
  instruction_files_affected: number;
  smartdocs_candidates_moved: number;
  cognition_files_to_generate: number;
}

export interface AdoptionPlan {
  plan_id: string;
  generated_at: string;
  repo_state: RepoScanInventory["repo_state"];
  approved: boolean;
  approved_at: string | null;
  dry_run: boolean;
  steps: AdoptionStep[];
  impact_summary: AdoptionImpact;
}

export interface GenerateAdoptionPlanOptions {
  dryRun?: boolean;
  now?: Date;
  operatorContext?: OperatorContext;
}

export interface AdoptionPlanArtifacts {
  plan: AdoptionPlan;
  json: string;
  markdown: string;
  jsonPath: string;
  markdownPath: string;
  wroteFiles: boolean;
}

function formatPlanId(isoTimestamp: string): string {
  return `adoption-${isoTimestamp.replaceAll(":", "-")}`;
}

function normalizePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function isTrusted(path: string, operatorContext?: OperatorContext): boolean {
  const normalized = normalizePath(path);
  return operatorContext?.trusted_docs.some((p) => normalizePath(p) === normalized) ?? false;
}

function isStale(path: string, operatorContext?: OperatorContext): boolean {
  const normalized = normalizePath(path);
  return operatorContext?.stale_docs.some((p) => normalizePath(p) === normalized) ?? false;
}

function isNeverTouch(path: string, operatorContext?: OperatorContext): boolean {
  const normalized = normalizePath(path);
  return operatorContext?.never_touch.some((p) => normalizePath(p) === normalized) ?? false;
}

function instructionIntent(
  path: string,
  operatorContext?: OperatorContext,
): OperatorContext["instruction_file_intent"][string] | undefined {
  return operatorContext?.instruction_file_intent[path];
}

function deriveSmartDocsRouting(
  candidate: SmartDocsCandidate,
  operatorContext?: OperatorContext,
): { routing: DocRouting; evidence_refs: string[]; operator_refs: string[] } {
  const evidence_refs = [`scan:smartdocs_candidate:${candidate.path}`];
  const operator_refs: string[] = [];

  if (isNeverTouch(candidate.path, operatorContext) || isStale(candidate.path, operatorContext)) {
    if (isNeverTouch(candidate.path, operatorContext)) operator_refs.push(`operator:never_touch:${candidate.path}`);
    if (isStale(candidate.path, operatorContext)) operator_refs.push(`operator:stale_docs:${candidate.path}`);
    return { routing: "hold", evidence_refs, operator_refs };
  }

  if (isTrusted(candidate.path, operatorContext)) {
    operator_refs.push(`operator:trusted_docs:${candidate.path}`);
    return { routing: "candidate", evidence_refs, operator_refs };
  }

  return { routing: "review-required", evidence_refs, operator_refs };
}

function createStep(
  order: number,
  partial: Omit<AdoptionStep, "order" | "status"> & {
    evidence_refs?: string[];
    operator_refs?: string[];
    routing?: DocRouting;
  },
): AdoptionStep {
  const { evidence_refs, operator_refs, routing, ...rest } = partial;
  return {
    evidence_refs: evidence_refs ?? [],
    operator_refs: operator_refs ?? [],
    routing: routing ?? "candidate",
    ...rest,
    order,
    status: "pending",
  };
}

function buildSteps(
  inventory: RepoScanInventory,
  operatorContext?: OperatorContext,
): AdoptionStep[] {
  const steps: AdoptionStep[] = [];
  let order = 1;

  steps.push(
    createStep(order++, {
      step_id: "provider-config-lock",
      phase: "A",
      category: "provider-config",
      action: "modify",
      dest_path: "polaris.config.json",
      description: "Write minimal provider config lock before adoption scan/mutations.",
      destructive: true,
      requires_approval: false,
      estimated_risk: "low",
      routing: "candidate",
      evidence_refs: ["adoption:step:provider-config-lock"],
      operator_refs: [],
    }),
  );

  steps.push(
    createStep(order++, {
      step_id: "adoption-scaffold",
      phase: "A",
      category: "scaffold",
      action: "create",
      dest_path: ".polaris/",
      description: "Ensure Polaris scaffold files/folders required for adoption workflow exist.",
      destructive: false,
      requires_approval: false,
      estimated_risk: "low",
      routing: "candidate",
      evidence_refs: ["adoption:step:adoption-scaffold"],
      operator_refs: [],
    }),
  );

  steps.push(
    createStep(order++, {
      step_id: "workspace-root-surfaces",
      phase: "A",
      category: "scaffold",
      action: "create",
      dest_path: "CLAUDE.md, AGENTS.md, .github/copilot-instructions.md",
      description: "Create root POLARIS.md, SUMMARY.md, and thin-pointer agent instruction files if missing.",
      destructive: false,
      requires_approval: false,
      estimated_risk: "low",
      routing: "candidate",
      evidence_refs: ["adoption:step:workspace-root-surfaces"],
      operator_refs: [],
    }),
  );

  for (const candidate of inventory.smartdocs_candidates) {
    const { routing, evidence_refs, operator_refs } = deriveSmartDocsRouting(
      candidate,
      operatorContext,
    );
    const stepOrder = order++;
    steps.push(
      createStep(stepOrder, {
        step_id: `smartdocs-migrate-${stepOrder.toString().padStart(3, "0")}`,
        phase: "C",
        category: "smartdocs-migrate",
        action: "move",
        source_path: candidate.path,
        dest_path: candidate.suggested_destination,
        description: `Move ${candidate.path} to ${candidate.suggested_destination}.`,
        destructive: true,
        requires_approval: true,
        estimated_risk: candidate.estimated_risk,
        routing,
        evidence_refs,
        operator_refs,
      }),
    );
  }

  for (const folder of inventory.likely_canonical_folders) {
    const normalizedFolder = normalizePath(folder);
    const evidence_refs = [`scan:canonical_folder:${normalizedFolder}`];
    const operator_refs: string[] = [];
    let routing: DocRouting = "raw";
    if (isNeverTouch(normalizedFolder, operatorContext)) {
      routing = "hold";
      operator_refs.push(`operator:never_touch:${normalizedFolder}`);
    } else if (isTrusted(normalizedFolder, operatorContext)) {
      routing = "candidate";
      operator_refs.push(`operator:trusted_docs:${normalizedFolder}`);
    }
    const stepOrder = order++;
    steps.push(
      createStep(stepOrder, {
        step_id: `cognition-generate-${stepOrder.toString().padStart(3, "0")}`,
        phase: "C",
        category: "cognition-generate",
        action: "create",
        dest_path: normalizedFolder,
        description: `Generate ${normalizedFolder}/POLARIS.md and ${normalizedFolder}/SUMMARY.md templates if missing.`,
        destructive: false,
        requires_approval: true,
        estimated_risk: "medium",
        routing,
        evidence_refs,
        operator_refs,
      }),
    );
  }

  for (const file of inventory.agent_instruction_files) {
    const action = file.recommendation === "preserve" ? "skip" : "modify";
    const destructive = action === "modify";
    const risk: AdoptionStep["estimated_risk"] =
      file.recommendation === "migrate"
        ? "high"
        : file.recommendation === "thin-adapter"
          ? "medium"
          : "low";
    const evidence_refs = [`scan:agent_instruction_file:${file.path}`];
    const operator_refs: string[] = [];
    const intent = instructionIntent(file.path, operatorContext);
    let routing: DocRouting;
    if (intent === "preserve") {
      routing = "hold";
      operator_refs.push(`operator:instruction_file_intent:${file.path}:preserve`);
    } else if (intent === "migrate" || intent === "thin-adapter") {
      routing = "candidate";
      operator_refs.push(`operator:instruction_file_intent:${file.path}:${intent}`);
    } else {
      routing = "review-required";
    }

    const stepOrder = order++;
    steps.push(
      createStep(stepOrder, {
        step_id: `instruction-refactor-${stepOrder.toString().padStart(3, "0")}`,
        phase: "C",
        category: "instruction-refactor",
        action,
        source_path: file.path,
        dest_path:
          file.recommendation === "migrate"
            ? `smartdocs/raw/migrated-instructions/${file.path.split("/").pop() ?? "instruction.md"}`
            : file.path,
        description:
          action === "skip"
            ? `Preserve instruction file ${file.path} (${file.reason}).`
            : `Apply ${file.recommendation} strategy to ${file.path} (${file.reason}).`,
        destructive,
        requires_approval: destructive,
        estimated_risk: risk,
        routing,
        evidence_refs,
        operator_refs,
      }),
    );
  }

  for (const ignorePath of inventory.ignore_candidates) {
    const stepOrder = order++;
    steps.push(
      createStep(stepOrder, {
        step_id: `ignore-rules-${stepOrder.toString().padStart(3, "0")}`,
        phase: "C",
        category: "ignore-rules",
        action: "append",
        dest_path: ".polarisignore",
        description: `Append ${ignorePath} to .polarisignore.`,
        destructive: true,
        requires_approval: true,
        estimated_risk: "low",
        routing: "candidate",
        evidence_refs: [`scan:ignore_candidate:${ignorePath}`],
        operator_refs: [],
      }),
    );
  }

  steps.push(
    createStep(order++, {
      step_id: "atlas-generate",
      phase: "C",
      category: "atlas-generate",
      action: "modify",
      dest_path: ".polaris/map/index.json",
      description: "Run polaris map index and record adoption baseline coverage.",
      destructive: true,
      requires_approval: true,
      estimated_risk: "medium",
      routing: "candidate",
      evidence_refs: ["adoption:step:atlas-generate"],
      operator_refs: [],
    }),
  );

  steps.push(
    createStep(order++, {
      step_id: "stage-adoption",
      phase: "C",
      category: "stage",
      action: "modify",
      dest_path: ".git/index",
      description: "Stage coherent adoption changes and prepare optional commit.",
      destructive: true,
      requires_approval: true,
      estimated_risk: "medium",
      routing: "candidate",
      evidence_refs: ["adoption:step:stage-adoption"],
      operator_refs: [],
    }),
  );

  return steps;
}

function buildImpactSummary(steps: AdoptionStep[], inventory: RepoScanInventory): AdoptionImpact {
  const filesToCreate = steps.filter((step) => step.action === "create").length;
  const filesToMove = steps.filter((step) => step.action === "move").length;
  const filesToModify = steps.filter(
    (step) => step.action === "modify" || step.action === "append",
  ).length;

  const instructionFilesAffected = steps.filter(
    (step) => step.category === "instruction-refactor" && step.action !== "skip",
  ).length;

  return {
    files_to_create: filesToCreate,
    files_to_move: filesToMove,
    files_to_modify: filesToModify,
    instruction_files_affected: instructionFilesAffected,
    smartdocs_candidates_moved: inventory.smartdocs_candidates.length,
    cognition_files_to_generate: inventory.likely_canonical_folders.length * 2,
  };
}

export function generateAdoptionPlan(
  inventory: RepoScanInventory,
  options: GenerateAdoptionPlanOptions = {},
): AdoptionPlan {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const steps = buildSteps(inventory, options.operatorContext);
  return {
    plan_id: formatPlanId(generatedAt),
    generated_at: generatedAt,
    repo_state: inventory.repo_state,
    approved: false,
    approved_at: null,
    dry_run: options.dryRun ?? false,
    steps,
    impact_summary: buildImpactSummary(steps, inventory),
  };
}

export function renderAdoptionPlanMarkdown(plan: AdoptionPlan): string {
  const lines: string[] = [];
  lines.push("# Adoption Plan");
  lines.push("");
  lines.push(`- Plan ID: \`${plan.plan_id}\``);
  lines.push(`- Generated at: ${plan.generated_at}`);
  lines.push(`- Repo state: ${plan.repo_state}`);
  lines.push(`- Approved: ${plan.approved ? "yes" : "no"}`);
  lines.push(`- Approved at: ${plan.approved_at ?? "n/a"}`);
  lines.push(`- Dry run: ${plan.dry_run ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Impact Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Files to create | ${plan.impact_summary.files_to_create} |`);
  lines.push(`| Files to move | ${plan.impact_summary.files_to_move} |`);
  lines.push(`| Files to modify | ${plan.impact_summary.files_to_modify} |`);
  lines.push(
    `| Instruction files affected | ${plan.impact_summary.instruction_files_affected} |`,
  );
  lines.push(
    `| SmartDocs candidates moved | ${plan.impact_summary.smartdocs_candidates_moved} |`,
  );
  lines.push(
    `| Cognition files to generate | ${plan.impact_summary.cognition_files_to_generate} |`,
  );
  lines.push("");

  for (const phase of ["A", "B", "C"] as const) {
    const phaseSteps = plan.steps.filter((step) => step.phase === phase);
    lines.push(`## Phase ${phase}`);
    lines.push("");

    if (phaseSteps.length === 0) {
      lines.push("_No steps._");
      lines.push("");
      continue;
    }

    for (const step of phaseSteps) {
      const source = step.source_path ? ` source: \`${step.source_path}\`` : "";
      const dest = step.dest_path ? ` destination: \`${step.dest_path}\`` : "";
      lines.push(
        `- **${step.order}. ${step.step_id}** — ${step.category} / ${step.action} / approval ${step.requires_approval ? "required" : "not required"} / risk ${step.estimated_risk} / routing ${step.routing} / status ${step.status}${source}${dest}`,
      );
      lines.push(`  - ${step.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function generateAdoptionPlanArtifacts(
  repoRoot: string,
  inventory: RepoScanInventory,
  options: GenerateAdoptionPlanOptions = {},
): AdoptionPlanArtifacts {
  const plan = generateAdoptionPlan(inventory, options);
  const jsonPath = join(repoRoot, ".polaris", "adoption-plan.json");
  const markdownPath = join(repoRoot, ".polaris", "adoption-plan.md");
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  const markdown = renderAdoptionPlanMarkdown(plan);

  mkdirSync(join(repoRoot, ".polaris"), { recursive: true });
  writeFileSync(jsonPath, json, "utf-8");
  writeFileSync(markdownPath, markdown, "utf-8");

  return {
    plan,
    json,
    markdown,
    jsonPath,
    markdownPath,
    wroteFiles: true,
  };
}
