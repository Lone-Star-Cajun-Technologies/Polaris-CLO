import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

function createStep(
  order: number,
  partial: Omit<AdoptionStep, "order" | "status">,
): AdoptionStep {
  return {
    ...partial,
    order,
    status: "pending",
  };
}

function buildSteps(inventory: RepoScanInventory): AdoptionStep[] {
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
    }),
  );

  for (const candidate of inventory.smartdocs_candidates) {
    steps.push(
      createStep(order++, {
        step_id: `smartdocs-migrate-${order.toString().padStart(3, "0")}`,
        phase: "C",
        category: "smartdocs-migrate",
        action: "move",
        source_path: candidate.path,
        dest_path: candidate.suggested_destination,
        description: `Move ${candidate.path} to ${candidate.suggested_destination}.`,
        destructive: true,
        requires_approval: true,
        estimated_risk: candidate.estimated_risk,
      }),
    );
  }

  for (const folder of inventory.likely_canonical_folders) {
    const normalizedFolder = normalizePath(folder);
    steps.push(
      createStep(order++, {
        step_id: `cognition-generate-${order.toString().padStart(3, "0")}`,
        phase: "C",
        category: "cognition-generate",
        action: "create",
        dest_path: normalizedFolder,
        description: `Generate ${normalizedFolder}/POLARIS.md and ${normalizedFolder}/SUMMARY.md templates if missing.`,
        destructive: false,
        requires_approval: true,
        estimated_risk: "medium",
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

    steps.push(
      createStep(order++, {
        step_id: `instruction-refactor-${order.toString().padStart(3, "0")}`,
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
      }),
    );
  }

  for (const ignorePath of inventory.ignore_candidates) {
    steps.push(
      createStep(order++, {
        step_id: `ignore-rules-${order.toString().padStart(3, "0")}`,
        phase: "C",
        category: "ignore-rules",
        action: "append",
        dest_path: ".polarisignore",
        description: `Append ${ignorePath} to .polarisignore.`,
        destructive: true,
        requires_approval: true,
        estimated_risk: "low",
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
  const steps = buildSteps(inventory);
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
        `- **${step.order}. ${step.step_id}** — ${step.category} / ${step.action} / approval ${step.requires_approval ? "required" : "not required"} / risk ${step.estimated_risk} / status ${step.status}${source}${dest}`,
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
