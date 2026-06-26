import { join } from "node:path";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { scanRepo } from "./adopt-scan.js";
import {
  generateAdoptionPlan,
  generateAdoptionPlanArtifacts,
} from "./adoption-plan.js";
import type { RepoScanInventory, AdoptionPlan } from "./adoption-plan.js";
import { runAgentSetup, resolveForeman } from "./agent-setup.js";
import { migrateSmartDocs } from "./adopt-smartdocs.js";
import { installWorkspaceAssets, runGraphBuild } from "./adopt-assets.js";
import { generatePolarisRules } from "./adopt-rules.js";
import { generateFolderCognition } from "./adopt-cognition.js";
import { enrichCanonFiles } from "./adopt-canon.js";
import { reconcileAgentFiles } from "./adopt-genesis.js";
import { generateSetupBootstrapPacket } from "../skill-packet/generator.js";
import { dispatchForeman } from "../loop/adapters/foreman-dispatch.js";
import type { ExecutionConfig } from "../config/schema.js";
import {
  loadOperatorContext,
  saveOperatorContext,
  createEmptyOperatorContext,
} from "./adoption-context.js";
import type { OperatorContext } from "./adoption-context.js";
import { requireApprovalGates } from "./adopt-approve.js";

export type AdoptPhase =
  | "scan"
  | "interview"
  | "agents"
  | "consolidate"
  | "map"
  | "skills"
  | "rules"
  | "canon";

export interface AdoptPhaseOptions {
  inventory?: RepoScanInventory;
  plan?: AdoptionPlan;
  dryRun?: boolean;
  skipAgents?: boolean;
}

/** Prompt a single question via stdin and return the trimmed answer. */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Run a Foreman-led interview seeded from inventory gaps.
 * Skips questions already answered (resume support).
 */
export async function runAdoptionInterview(
  repoRoot: string,
  inventory: RepoScanInventory,
): Promise<OperatorContext> {
  const existing = loadOperatorContext(repoRoot);
  const ctx = existing ?? createEmptyOperatorContext();

  // Seed: untrusted docs (smartdocs candidates not yet classified as trusted/stale)
  const candidatePaths = inventory.smartdocs_candidates.map((c) => c.path);
  const unclassified = candidatePaths.filter(
    (p) => !ctx.trusted_docs.includes(p) && !ctx.stale_docs.includes(p),
  );

  if (unclassified.length > 0) {
    process.stdout.write(
      `\nFound ${unclassified.length} doc candidate(s) not yet classified:\n` +
        unclassified.map((p) => `  - ${p}`).join("\n") +
        "\n",
    );
    const trusted = await prompt(
      "Which of these are authoritative/trusted? (comma-separated paths, or leave blank to skip): ",
    );
    const stale = await prompt(
      "Which are stale/outdated? (comma-separated paths, or leave blank to skip): ",
    );
    if (trusted) ctx.trusted_docs.push(...trusted.split(",").map((s) => s.trim()).filter(Boolean));
    if (stale) ctx.stale_docs.push(...stale.split(",").map((s) => s.trim()).filter(Boolean));
  }

  // Seed: ambiguous source roots (more than one detected)
  if (inventory.source_roots.length > 1 && ctx.priority_systems.length === 0) {
    process.stdout.write(
      `\nMultiple source roots detected: ${inventory.source_roots.join(", ")}\n`,
    );
    const priority = await prompt(
      "Which are the primary/priority systems? (comma-separated, or leave blank): ",
    );
    if (priority)
      ctx.priority_systems.push(...priority.split(",").map((s) => s.trim()).filter(Boolean));
  }

  // Seed: instruction files not yet assigned intent
  const unintended = inventory.agent_instruction_files
    .map((f) => f.path)
    .filter((p) => !(p in ctx.instruction_file_intent));
  for (const filePath of unintended) {
    const file = inventory.agent_instruction_files.find((f) => f.path === filePath);
    const suggestion = file?.recommendation ?? "preserve";
    const answer = await prompt(
      `Instruction file "${filePath}" — intent? [preserve/migrate/thin-adapter] (default: ${suggestion}): `,
    );
    const intent = (["preserve", "migrate", "thin-adapter"] as const).find(
      (v) => v === answer,
    ) ?? suggestion;
    ctx.instruction_file_intent[filePath] = intent;
  }

  // Seed: canonical-folder candidates not yet classified as trusted or never-touch
  const uncheckedFolders = inventory.likely_canonical_folders.filter(
    (f) => !ctx.trusted_docs.includes(f) && !ctx.never_touch.includes(f),
  );
  if (uncheckedFolders.length > 0) {
    process.stdout.write(
      `\nLikely canonical folders: ${uncheckedFolders.join(", ")}\n`,
    );
    const neverTouch = await prompt(
      "Any folders that should never be touched by adoption? (comma-separated, or leave blank): ",
    );
    if (neverTouch)
      ctx.never_touch.push(...neverTouch.split(",").map((s) => s.trim()).filter(Boolean));
  }

  ctx.answered_at = new Date().toISOString();
  saveOperatorContext(repoRoot, ctx);
  return ctx;
}

function estimateTokenCost(inventory: RepoScanInventory): string {
  const total =
    inventory.smartdocs_candidates.length +
    inventory.likely_canonical_folders.length;
  if (total === 0) return "minimal";
  if (total < 20) return "low (~50k tokens)";
  if (total < 100) return "moderate (~200k tokens)";
  return "high (500k+ tokens) — consider running phases separately";
}

export async function runAdoptPhase(
  phase: AdoptPhase,
  repoRoot: string,
  options: AdoptPhaseOptions = {},
): Promise<void> {
  switch (phase) {
    case "scan": {
      const inventory = await scanRepo(repoRoot, { rescan: true });
      const plan = generateAdoptionPlan(inventory);
      generateAdoptionPlanArtifacts(repoRoot, inventory);
      console.log(
        `Scan complete: ${inventory.smartdocs_candidates.length} doc(s), ${inventory.likely_canonical_folders.length} folder(s).`,
      );
      break;
    }

    case "interview": {
      const inventory =
        options.inventory ?? (await scanRepo(repoRoot, { rescan: false }));
      await runAdoptionInterview(repoRoot, inventory);
      console.log("Interview complete. Operator context saved.");
      break;
    }

    case "agents": {
      if (options.inventory) {
        const cost = estimateTokenCost(options.inventory);
        process.stdout.write(
          `\nToken cost estimate for this repo: ${cost}\nAgent-assisted phases (consolidate, canon) will use your configured provider.\n\n`,
        );
      }
      if (!options.skipAgents) {
        await runAgentSetup(repoRoot);
      }
      // Dispatch the Foreman with the setup-bootstrap packet.
      try {
        const configPath = join(repoRoot, "polaris.config.json");
        const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
        const execution = config.execution as ExecutionConfig | undefined;
        if (execution?.providers && Object.keys(execution.providers).length > 0) {
          const binding = await resolveForeman(repoRoot, config);
          const setupPacket = generateSetupBootstrapPacket("adopt");
          await dispatchForeman({
            packet: setupPacket,
            provider: binding.provider,
            executionConfig: execution,
          });
        }
      } catch {
        // Foreman dispatch is best-effort — don't block adoption.
      }
      break;
    }

    case "consolidate": {
      if (!options.inventory || !options.plan) {
        throw new Error("consolidate requires inventory and plan");
      }
      await migrateSmartDocs(options.plan, repoRoot);
      await reconcileAgentFiles(repoRoot);
      break;
    }

    case "map": {
      const result = runGraphBuild(repoRoot);
      if (result.status === "graph-failed") {
        const msg = `Map build failed: ${result.reason ?? "unknown error"}`;
        process.stderr.write(`${msg}\n`);
        if (result.followUpCommand) {
          process.stderr.write(`Run: ${result.followUpCommand}\n`);
        }
        throw new Error(msg);
      }
      process.stdout.write("Map built successfully.\n");
      return;
    }

    case "skills": {
      const workspaceDir = join(repoRoot, ".polaris", "workspace");
      const result = installWorkspaceAssets(repoRoot, workspaceDir);
      console.log(
        `Skills: ${result.installed.length} installed, ${result.alreadyPresent.length} already present.`,
      );
      break;
    }

    case "rules": {
      const inventory =
        options.inventory ?? (await scanRepo(repoRoot, { rescan: false }));
      await generatePolarisRules(repoRoot, inventory);
      console.log("POLARIS_RULES.md written.");
      break;
    }

    case "canon": {
      const inventory =
        options.inventory ?? (await scanRepo(repoRoot, { rescan: false }));
      const plan =
        options.plan ?? generateAdoptionPlan(inventory);
      await generateFolderCognition(plan, inventory, repoRoot);
      await enrichCanonFiles(repoRoot);
      console.log("POLARIS.md and SUMMARY.md files written and enriched.");
      break;
    }

    default: {
      throw new Error(`Unknown adopt phase: ${String(phase)}`);
    }
  }
}

export async function runFullAdoption(
  repoRoot: string,
  options: { skipAgents?: boolean } = {},
): Promise<void> {
  console.log("[1/8] scan");
  await runAdoptPhase("scan", repoRoot);
  // Re-read inventory and plan for later phases
  const inventory = await scanRepo(repoRoot, { rescan: false });
  const plan = generateAdoptionPlan(inventory);

  console.log("[2/8] interview");
  await runAdoptPhase("interview", repoRoot, { inventory });

  console.log("[3/8] agents");
  await runAdoptPhase("agents", repoRoot, {
    inventory,
    skipAgents: options.skipAgents,
  });

  // Approval gates: one per mutation category before any broad mutation.
  const gatesApproved = await requireApprovalGates(plan, { repoRoot });
  if (!gatesApproved) {
    return;
  }

  console.log("[4/8] consolidate");
  await runAdoptPhase("consolidate", repoRoot, { inventory, plan });

  console.log("[5/8] map");
  await runAdoptPhase("map", repoRoot);

  console.log("[6/8] skills");
  await runAdoptPhase("skills", repoRoot);

  console.log("[7/8] rules");
  await runAdoptPhase("rules", repoRoot, { inventory });

  console.log("[8/8] canon");
  await runAdoptPhase("canon", repoRoot, { inventory, plan });
}

export function createAdoptCommand(opts: { repoRoot: string }): Command {
  const { repoRoot } = opts;
  const cmd = new Command("adopt").description(
    "Onboard this repository to Polaris — run all adoption phases in sequence",
  );

  cmd.action(async () => {
    await runFullAdoption(repoRoot);
  });

  cmd
    .command("scan")
    .description("Scan the repository and generate adoption plan")
    .action(async () => {
      await runAdoptPhase("scan", repoRoot);
    });

  cmd
    .command("interview")
    .description("Run Foreman-led interview to capture operator context")
    .option("--resume", "resume a previous interview (skips already-answered questions)")
    .action(async () => {
      const inventory = await scanRepo(repoRoot, { rescan: false });
      await runAdoptPhase("interview", repoRoot, { inventory });
    });

  cmd
    .command("agents")
    .description("Set up agent instruction files")
    .option("--skip", "skip running agent setup")
    .action(async (cmdOpts: { skip?: boolean }) => {
      await runAdoptPhase("agents", repoRoot, { skipAgents: cmdOpts.skip });
    });

  cmd
    .command("consolidate")
    .description("Migrate SmartDocs and reconcile agent files")
    .option("--dry-run", "preview changes without writing")
    .action(async (cmdOpts: { dryRun?: boolean }) => {
      const inventory = await scanRepo(repoRoot, { rescan: false });
      const plan = generateAdoptionPlan(inventory);
      if (cmdOpts.dryRun) {
        plan.dry_run = true;
      }
      await runAdoptPhase("consolidate", repoRoot, { inventory, plan });
    });

  cmd
    .command("map")
    .description("Build the file route map")
    .action(async () => {
      await runAdoptPhase("map", repoRoot);
    });

  cmd
    .command("skills")
    .description("Install workspace assets and skills")
    .action(async () => {
      await runAdoptPhase("skills", repoRoot);
    });

  cmd
    .command("rules")
    .description("Generate POLARIS_RULES.md")
    .action(async () => {
      await runAdoptPhase("rules", repoRoot);
    });

  cmd
    .command("canon")
    .description("Generate POLARIS.md and SUMMARY.md cognition files")
    .action(async () => {
      await runAdoptPhase("canon", repoRoot);
    });

  return cmd;
}
