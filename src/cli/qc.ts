import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { QC_RESOLUTION_OUTCOMES } from "../qc/types.js";
import {
  getResolverIdentity,
  resolveQcResolutionFindings,
  writeQcResolutionArtifact,
} from "../qc/repair-loop.js";
import { readRepairPacketManifest } from "../qc/repair-packets.js";

export function createQcCommand(options: { repoRoot?: string } = {}): Command {
  const repoRootDefault = options.repoRoot ?? resolve(process.cwd());

  const qc = new Command("qc")
    .description("QC role tools")
    .showHelpAfterError()
    .showSuggestionAfterError();

  qc
    .command("resolve")
    .description(
      "Record a formal operator resolution for a QC repair-loop terminal state",
    )
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .requiredOption("--cluster-id <id>", "Cluster ID to resolve")
    .requiredOption(
      "--outcome <outcome>",
      "Resolved outcome (pass or no-repairable)",
    )
    .requiredOption("--reason <text>", "Reason for the resolution")
    .option(
      "--findings <ids>",
      "Comma-separated finding IDs covered by this resolution (defaults to all in the round manifest)",
    )
    .action(
      (
        cmdOptions: {
          repoRoot: string;
          clusterId: string;
          outcome: string;
          reason: string;
          findings?: string;
        },
      ) => {
        try {
          resolveQcRepairLoop({
            repoRoot: cmdOptions.repoRoot,
            clusterId: cmdOptions.clusterId,
            outcome: cmdOptions.outcome,
            reason: cmdOptions.reason,
            findings: cmdOptions.findings,
          });
        } catch (err) {
          process.stderr.write(
            `qc resolve error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      },
    );

  return qc;
}

interface ResolveQcRepairLoopOptions {
  repoRoot: string;
  clusterId: string;
  outcome: string;
  reason: string;
  findings?: string;
}

function resolveQcRepairLoop(options: ResolveQcRepairLoopOptions): void {
  const { repoRoot, clusterId, outcome, reason, findings } = options;

  const allowedOutcomes = new Set<string>(QC_RESOLUTION_OUTCOMES);
  if (!allowedOutcomes.has(outcome)) {
    throw new Error(
      `Invalid outcome "${outcome}". Must be one of: ${QC_RESOLUTION_OUTCOMES.join(", ")}.`,
    );
  }

  const resolvedReason = reason.trim();
  if (resolvedReason === "") {
    throw new Error("A non-empty --reason is required to record a resolution.");
  }

  const round = findCurrentRepairRound(repoRoot, clusterId);
  if (round === null) {
    throw new Error(
      `No repair-round manifest found for cluster ${clusterId}. Run the QC repair loop first.`,
    );
  }

  const manifest = readRepairPacketManifest(clusterId, round, repoRoot);
  if (!manifest) {
    throw new Error(
      `Repair packet manifest for cluster ${clusterId} round ${round} is missing or invalid.`,
    );
  }

  const explicitFindings = findings
    ? findings
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : undefined;

  const resolvedFindings = resolveQcResolutionFindings(
    manifest,
    explicitFindings,
  );

  const resolver = getResolverIdentity(repoRoot);

  const artifactPath = writeQcResolutionArtifact({
    clusterId,
    round,
    resolver,
    resolvedOutcome: outcome as "pass" | "no-repairable",
    reason: resolvedReason,
    findings: resolvedFindings,
    repoRoot,
  });

  process.stdout.write(
    `Created resolution artifact: ${artifactPath}\n` +
      `Resolved outcome: ${outcome}\n` +
      `Resolved findings: ${resolvedFindings.join(", ") || "none"}\n`,
  );
}

function findCurrentRepairRound(
  repoRoot: string,
  clusterId: string,
): number | null {
  const roundsDir = join(
    repoRoot,
    ".polaris",
    "clusters",
    clusterId,
    "qc",
    "repair-rounds",
  );
  if (!existsSync(roundsDir)) {
    return null;
  }

  const entries = readdirSync(roundsDir, { withFileTypes: true });
  const rounds = entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => b - a);

  for (const round of rounds) {
    const manifestPath = join(roundsDir, String(round), "repair-packets.json");
    if (existsSync(manifestPath)) {
      return round;
    }
  }

  return null;
}
