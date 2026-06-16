import { Command } from "commander";
import { scanRepo } from "./adopt-scan.js";
import {
  generateAdoptionPlan,
  generateAdoptionPlanArtifacts,
} from "./adoption-plan.js";
import type { RepoScanInventory, AdoptionPlan } from "./adoption-plan.js";
import { runAgentSetup } from "./agent-setup.js";
import { migrateSmartDocs } from "./adopt-smartdocs.js";
import { installWorkspaceAssets, runGraphBuild } from "./adopt-assets.js";
import { generatePolarisRules } from "./adopt-rules.js";
import { generateFolderCognition } from "./adopt-cognition.js";
import { enrichCanonFiles } from "./adopt-canon.js";
import { reconcileAgentFiles } from "./adopt-genesis.js";

export type AdoptPhase =
  | "scan"
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
      generateAdoptionPlanArtifacts(plan, repoRoot);
      console.log(
        `Scan complete: ${inventory.smartdocs_candidates.length} doc(s), ${inventory.likely_canonical_folders.length} folder(s).`,
      );
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
        process.stderr.write(
          `Map build failed: ${result.reason ?? "unknown error"}\n`,
        );
      } else {
        console.log("Map built successfully.");
      }
      break;
    }

    case "skills": {
      const result = installWorkspaceAssets(repoRoot);
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
  options: { dryRun?: boolean; skipAgents?: boolean } = {},
): Promise<void> {
  console.log("[1/7] scan");
  await runAdoptPhase("scan", repoRoot);
  // Re-read inventory and plan for later phases
  const inventory = await scanRepo(repoRoot, { rescan: false });
  const plan = generateAdoptionPlan(inventory);

  console.log("[2/7] agents");
  await runAdoptPhase("agents", repoRoot, {
    inventory,
    skipAgents: options.skipAgents,
  });

  console.log("[3/7] consolidate");
  await runAdoptPhase("consolidate", repoRoot, { inventory, plan });

  console.log("[4/7] map");
  await runAdoptPhase("map", repoRoot);

  console.log("[5/7] skills");
  await runAdoptPhase("skills", repoRoot);

  console.log("[6/7] rules");
  await runAdoptPhase("rules", repoRoot, { inventory });

  console.log("[7/7] canon");
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
