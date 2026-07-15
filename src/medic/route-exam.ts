import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import { readFileRoutes, type FileRouteEntry } from "../map/atlas.js";
import {
  assessRouteHealth,
  readRouteHealthState,
  type RouteHealthState,
} from "../cognition/route-cognition-delta.js";
import { writeChart, type WriteChartInput } from "./run-health-consult.js";

export interface RouteExamPacket {
  route: string;
  health_state: RouteHealthState;
  polaris_md: string | null;
  summary_md: string | null;
  owned_paths: string[];
  chart_history: string[];
  relevant_tests: string[];
  timestamp: string;
}

export interface RouteExamResult {
  packet: RouteExamPacket;
  chart_id: string;
  chart_ref: string;
}

export interface RunRouteExamOptions {
  route: string;
  repoRoot: string;
  clusterId?: string;
  status?: string;
}

function normalizeRoute(route: string): string {
  return route.replace(/^\.?\//, "").replace(/\/+$/, "");
}

function readMapOutputPath(repoRoot: string): string {
  const config = loadConfig(repoRoot);
  return resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");
}

function readTextOrNull(repoRoot: string, relPath: string): string | null {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

function collectOwnedPaths(
  route: string,
  routes: Record<string, FileRouteEntry>,
): string[] {
  const paths: string[] = [];
  for (const [filePath, entry] of Object.entries(routes)) {
    if (entry.route === route || entry.route.startsWith(`${route}/`)) {
      paths.push(filePath);
    }
  }
  return paths.sort();
}

function determineHealthState(
  route: string,
  routes: Record<string, FileRouteEntry>,
  routeHealth: Record<string, RouteHealthState>,
  repoRoot: string,
): RouteHealthState {
  const ownedPaths = collectOwnedPaths(route, routes);
  const polarisPath = `${route}/POLARIS.md`;
  const summaryPath = `${route}/SUMMARY.md`;
  const representativePath = ownedPaths.includes(polarisPath)
    ? polarisPath
    : ownedPaths.includes(summaryPath)
      ? summaryPath
      : ownedPaths[0];

  if (representativePath) {
    const persisted = routeHealth[representativePath];
    if (persisted) return persisted;
    const entry = routes[representativePath];
    if (entry) return assessRouteHealth(entry, repoRoot);
  }

  // No map entry; use a coarse fallback based on file existence.
  const polarisMdAbs = resolve(repoRoot, route, "POLARIS.md");
  const summaryMdAbs = resolve(repoRoot, route, "SUMMARY.md");
  if (!existsSync(polarisMdAbs)) return "known-issues";
  if (!existsSync(summaryMdAbs)) return "monitoring";
  return "healthy";
}

function readChartHistory(repoRoot: string): string[] {
  const chartsDir = resolve(repoRoot, "smartdocs", "medic", "charts");
  if (!existsSync(chartsDir)) return [];
  try {
    return readdirSync(chartsDir).filter(
      (f) => f.startsWith("CHART-") && f.endsWith(".md"),
    );
  } catch {
    return [];
  }
}

export function runRouteExam(options: RunRouteExamOptions): RouteExamResult {
  const { route, repoRoot, clusterId = "UNKNOWN", status = "active" } = options;
  const normalizedRoute = normalizeRoute(route);

  const outputPath = readMapOutputPath(repoRoot);
  const routes = readFileRoutes(outputPath);
  const routeHealth = readRouteHealthState(outputPath);

  const ownedPaths = collectOwnedPaths(normalizedRoute, routes);
  const healthState = determineHealthState(
    normalizedRoute,
    routes,
    routeHealth,
    repoRoot,
  );

  const polarisMdPath = `${normalizedRoute}/POLARIS.md`;
  const summaryMdPath = `${normalizedRoute}/SUMMARY.md`;
  const polarisMd = readTextOrNull(repoRoot, polarisMdPath);
  const summaryMd = readTextOrNull(repoRoot, summaryMdPath);
  const chartHistory = readChartHistory(repoRoot);
  const relevantTests = ownedPaths.filter(
    (p) => p.endsWith(".test.ts") || p.endsWith(".test.js"),
  );

  const now = new Date().toISOString();

  const packet: RouteExamPacket = {
    route: normalizedRoute,
    health_state: healthState,
    polaris_md: polarisMd,
    summary_md: summaryMd,
    owned_paths: ownedPaths,
    chart_history: chartHistory,
    relevant_tests: relevantTests,
    timestamp: now,
  };

  const evidenceRefs = new Set<string>();
  if (polarisMd) evidenceRefs.add(polarisMdPath);
  if (summaryMd) evidenceRefs.add(summaryMdPath);
  for (const path of ownedPaths) evidenceRefs.add(path);

  const chart: WriteChartInput = {
    chart_id: "",
    cluster_id: clusterId,
    route: normalizedRoute,
    health_state: healthState,
    status,
    problem: `Proactive route exam for ${normalizedRoute}.`,
    symptoms: [
      {
        id: "route-exam",
        code: healthState,
        message: `Route ${normalizedRoute} health state is ${healthState}.`,
      },
    ],
    diagnosis: `Route exam for ${normalizedRoute} assessed health state as ${healthState}.`,
    evidence_refs: Array.from(evidenceRefs),
    decision: "no-treatment-needed",
    no_treatment_rationale:
      "No critical or high-severity run-health symptoms triggered this exam; observation and follow-up are sufficient.",
    follow_up_conditions: [
      `Re-check route health for ${normalizedRoute} after the next run or significant change.`,
    ],
    created_at: now,
  };

  const chartRef = writeChart(chart, `route-exam-${normalizedRoute}`, repoRoot);
  const chartId = chartRef.split("/").pop()?.replace(/\.md$/, "") ?? "";
  chart.chart_id = chartId;

  return {
    packet,
    chart_id: chartId,
    chart_ref: chartRef,
  };
}
