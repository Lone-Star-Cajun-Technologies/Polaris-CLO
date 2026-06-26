import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AdoptionPlan, AdoptionStep } from "./adoption-plan.js";
import { renderAdoptionPlanMarkdown } from "./adoption-plan.js";

export interface PromptApprovalOptions {
  repoRoot?: string;
  stdin?: Readable;
  stdout?: Writable;
  now?: Date;
  /** Optional markdown to display instead of the adoption plan markdown. */
  markdown?: string;
  /** Optional custom persistence function. Defaults to writing adoption-plan.json. */
  persist?: (plan: AdoptionPlan, repoRoot: string, now: Date) => void;
}

function adoptionPlanJsonPath(repoRoot: string): string {
  return join(repoRoot, ".polaris", "adoption-plan.json");
}

function adoptionPlanMarkdownPath(repoRoot: string): string {
  return join(repoRoot, ".polaris", "adoption-plan.md");
}

function adoptionTelemetryPath(repoRoot: string): string {
  return join(repoRoot, ".polaris", "adoption-telemetry.jsonl");
}

function writeTelemetryEvent(repoRoot: string, event: Record<string, unknown>): void {
  const telemetryPath = adoptionTelemetryPath(repoRoot);
  mkdirSync(dirname(telemetryPath), { recursive: true });
  appendFileSync(telemetryPath, `${JSON.stringify(event)}\n`, "utf-8");
}

export function persistApprovedAdoptionPlan(
  plan: AdoptionPlan,
  repoRoot = process.cwd(),
  now = new Date(),
): void {
  plan.approved = true;
  plan.approved_at = plan.approved_at ?? now.toISOString();

  const jsonPath = adoptionPlanJsonPath(repoRoot);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
}

export function logAdoptionApprovalTelemetry(
  repoRoot: string,
  event: Record<string, unknown>,
): void {
  writeTelemetryEvent(repoRoot, event);
}

export async function promptApproval(
  plan: AdoptionPlan,
  options: PromptApprovalOptions = {},
): Promise<boolean> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const markdownPath = adoptionPlanMarkdownPath(repoRoot);
  const markdown =
    options.markdown ??
    (existsSync(markdownPath)
      ? readFileSync(markdownPath, "utf-8")
      : renderAdoptionPlanMarkdown(plan));

  stdout.write(`${markdown.replace(/\s*$/, "")}\n\n`);

  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  let response = "";
  try {
    response = await rl.question("Proceed with adoption? [y/N] ");
  } finally {
    rl.close();
  }

  if (response.trim().toLowerCase() === "y") {
    const approvalNow = options.now ?? new Date();
    if (options.persist) {
      options.persist(plan, repoRoot, approvalNow);
    } else {
      persistApprovedAdoptionPlan(plan, repoRoot, approvalNow);
    }
    return true;
  }

  stdout.write("Adoption aborted: explicit approval required.\n");
  return false;
}

/**
 * Category labels used in approval gate display and telemetry.
 */
export type ApprovalCategory =
  | "doc-movement"
  | "instruction-file"
  | "graph-root"
  | "route-scaffold";

/** Map of category → step categories in AdoptionStep */
const CATEGORY_STEP_MAP: Record<ApprovalCategory, AdoptionStep["category"][]> = {
  "doc-movement": ["smartdocs-migrate"],
  "instruction-file": ["instruction-refactor"],
  "graph-root": ["cognition-generate", "atlas-generate"],
  "route-scaffold": ["scaffold"],
};

const CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  "doc-movement": "Document Movement",
  "instruction-file": "Instruction-File Changes",
  "graph-root": "Graph-Root / Cognition Changes",
  "route-scaffold": "Route Scaffolding",
};

export interface CategoryApprovalOptions {
  repoRoot?: string;
  stdin?: Readable;
  stdout?: Writable;
  now?: Date;
}

/**
 * Render a compact diff preview for the given steps.
 */
function renderStepDiff(steps: AdoptionStep[]): string {
  if (steps.length === 0) return "  (no steps)\n";
  return steps
    .map((s) => {
      const src = s.source_path ? ` ${s.source_path} →` : "";
      const dst = s.dest_path ? ` ${s.dest_path}` : "";
      const routing = s.routing ? ` [${s.routing}]` : "";
      return `  ${s.action.toUpperCase()}${src}${dst}${routing}  — ${s.description}`;
    })
    .join("\n") + "\n";
}

/**
 * Ask the operator for approval of a single mutation category.
 * Returns true if approved, false if declined.
 * Logs the decision via adoption telemetry.
 */
export async function promptCategoryApproval(
  category: ApprovalCategory,
  steps: AdoptionStep[],
  options: CategoryApprovalOptions = {},
): Promise<boolean> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;

  const label = CATEGORY_LABELS[category];
  const actionableSteps = steps.filter((s) => s.action !== "skip");

  stdout.write(`\n--- ${label} (${actionableSteps.length} step(s)) ---\n`);
  stdout.write(renderStepDiff(actionableSteps));

  const rl = createInterface({ input: stdin, output: stdout });
  let response = "";
  try {
    response = await rl.question(`Approve ${label}? [y/N] `);
  } finally {
    rl.close();
  }

  const approved = response.trim().toLowerCase() === "y";
  const now = (options.now ?? new Date()).toISOString();
  logAdoptionApprovalTelemetry(repoRoot, {
    event: "category-approval",
    category,
    approved,
    step_count: actionableSteps.length,
    timestamp: now,
  });

  if (!approved) {
    stdout.write(`Adoption aborted: ${label} approval required.\n`);
  }
  return approved;
}

/**
 * Fire approval gates for all four mutation categories in sequence.
 * Returns false (and stops) at the first declined category.
 *
 * For non-interactive runs (no tty + no supplied stdin), returns false immediately
 * unless `options.stdin` is explicitly set (which signals the caller supplied a context stream).
 */
export async function requireApprovalGates(
  plan: AdoptionPlan,
  options: CategoryApprovalOptions & { nonInteractiveSafe?: boolean } = {},
): Promise<boolean> {
  const stdin = options.stdin ?? process.stdin;
  // Non-interactive guard: if stdin is not a TTY and the caller hasn't explicitly supplied one,
  // block before mutation (acceptance criterion 2).
  if (!options.nonInteractiveSafe && stdin === process.stdin && !process.stdin.isTTY) {
    const stdout = options.stdout ?? process.stdout;
    stdout.write(
      "Adoption aborted: interactive approval is required. Re-run in a TTY (interactive terminal).\n",
    );
    logAdoptionApprovalTelemetry(options.repoRoot ?? process.cwd(), {
      event: "category-approval-blocked",
      reason: "non-interactive",
      timestamp: new Date().toISOString(),
    });
    return false;
  }

  const categories: ApprovalCategory[] = [
    "route-scaffold",
    "doc-movement",
    "instruction-file",
    "graph-root",
  ];

  for (const category of categories) {
    const stepCategories = CATEGORY_STEP_MAP[category];
    const steps = plan.steps.filter((s) => stepCategories.includes(s.category));
    // Skip gate if no actionable steps in this category
    if (steps.filter((s) => s.action !== "skip").length === 0) continue;

    const approved = await promptCategoryApproval(category, steps, options);
    if (!approved) return false;
  }

  return true;
}
