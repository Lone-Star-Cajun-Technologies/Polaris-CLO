import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AdoptionPlan } from "./adoption-plan.js";
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
