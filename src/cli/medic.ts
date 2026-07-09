import { Command } from "commander";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateNextChartId } from "../medic/chart-id.js";
import { loadConfig } from "../config/loader.js";
import { TerminalCliAdapter } from "../loop/adapters/terminal-cli.js";
import { runMedicRunHealthConsult } from "../medic/run-health-consult.js";
import { dispatchTreatmentWorker } from "../medic/treatment-packets.js";
import type { MedicRunHealthPacket } from "../types/result-packet.js";

export function createMedicCommand(options: { repoRoot?: string } = {}): Command {
  const repoRootDefault = options.repoRoot ?? resolve(process.cwd());

  const medic = new Command("medic")
    .description("Medic role tools")
    .showHelpAfterError()
    .showSuggestionAfterError();

  medic
    .command("chart")
    .description("Chart management commands")
    .addCommand(
      new Command("create")
        .description("Scaffold a new chart with a valid Chart ID")
        .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
        .option(
          "--cluster-id <id>",
          "Cluster ID for this chart",
          "UNKNOWN",
        )
        .option(
          "--route <path>",
          "Route path for this chart",
          "UNKNOWN",
        )
        .option(
          "--status <status>",
          "Chart status",
          "draft",
        )
        .action((cmdOptions: {
          repoRoot: string;
          clusterId: string;
          route: string;
          status: string;
        }) => {
          try {
            createChart({
              repoRoot: cmdOptions.repoRoot,
              clusterId: cmdOptions.clusterId,
              route: cmdOptions.route,
              status: cmdOptions.status,
            });
          } catch (err) {
            process.stderr.write(
              `medic chart create error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            process.exit(1);
          }
        }),
    );

  medic
    .command("run-health-consult")
    .description("Run a Medic run-health consult from a packet file")
    .requiredOption("--packet-file <path>", "Path to MedicRunHealthPacket JSON")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .action(async (cmdOptions: { packetFile: string; repoRoot: string }) => {
      const repoRoot = cmdOptions.repoRoot;
      let packet: MedicRunHealthPacket;
      try {
        packet = JSON.parse(readFileSync(cmdOptions.packetFile, "utf-8")) as MedicRunHealthPacket;
      } catch (err) {
        process.stderr.write(
          `medic run-health-consult error: cannot read packet: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
        return;
      }

      if (packet.role !== "medic-run-health") {
        process.stderr.write(
          `medic run-health-consult error: packet role must be \"medic-run-health\", got \"${packet.role}\"\n`,
        );
        process.exit(1);
        return;
      }

      const config = loadConfig(repoRoot);
      const adapter = new TerminalCliAdapter(config.execution);
      // Use shared provider resolution logic: prefer rotation, fall back to first provider
      const providerName =
        (config.execution.rotation && config.execution.rotation.length > 0)
          ? config.execution.rotation[0]
          : Object.keys(config.execution.providers ?? {})[0] ?? "terminal-cli";

      // Get current branch from git
      let branch = "main";
      try {
        const { execFileSync } = require("node:child_process");
        branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf-8",
        }).trim();
      } catch {
        // Fall back to main if git fails
      }

      try {
        const result = await runMedicRunHealthConsult({
          packet,
          repoRoot,
          stateFile: packet.cluster_state_path,
          telemetryFile: packet.telemetry_path,
          branch,
          dryRun: false,
          dispatchTreatmentWorkerFn: (input) =>
            dispatchTreatmentWorker({
              ...input,
              repoRoot,
              dispatch: (workerPacket) => adapter.dispatch(workerPacket, { provider: providerName }),
            }),
        });
        writeFileSync(packet.result_path, JSON.stringify(result, null, 2), "utf-8");
        process.stdout.write(`Medic run-health consult result written to ${packet.result_path}\n`);
      } catch (err) {
        process.stderr.write(
          `medic run-health-consult error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  return medic;
}

interface CreateChartOptions {
  repoRoot: string;
  clusterId: string;
  route: string;
  status: string;
}

function createChart(options: CreateChartOptions): void {
  const { repoRoot, clusterId, route, status } = options;

  // Ensure charts directory exists
  const chartsDir = resolve(repoRoot, "smartdocs/medic/charts");
  mkdirSync(chartsDir, { recursive: true });

  // Generate next Chart ID
  const chartId = generateNextChartId(chartsDir);

  // Get current timestamp
  const now = new Date().toISOString();

  // Create chart content
  const chartContent = `---
chart_id: ${chartId.full}
cluster_id: ${clusterId}
route: ${route}
status: ${status}
related_charts: []
created: ${now}
updated: ${now}
---

## Problem

Describe the problem diagnosed by the Medic.

## Symptoms

List the symptoms that led to this diagnosis.

## Root Cause

Explain the root cause of the failure.

## Affected Files

List the files affected by this issue.

## Treatment

Describe the treatment applied to fix the issue.

## Validation

Describe how the fix was validated.

## Prevention

Describe how to prevent this issue from recurring.

## When To Read This Chart

Describe the conditions under which this chart should be retrieved.
`;

  // Write chart file
  const chartPath = resolve(chartsDir, `${chartId.full}.md`);
  writeFileSync(chartPath, chartContent, "utf-8");

  process.stdout.write(`Created chart: ${chartPath}\n`);
  process.stdout.write(`Chart ID: ${chartId.full}\n`);
}