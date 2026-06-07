import { Command } from "commander";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateNextChartId } from "../medic/chart-id.js";

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