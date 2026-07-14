import { resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import {
  RouteHealthState,
  assessRouteHealth,
  readRouteHealthState,
} from "../cognition/route-cognition-delta.js";
import { readFileRoutes, type FileRouteEntry } from "./atlas.js";

export type { RouteHealthState } from "../cognition/route-cognition-delta.js";

export type ActionRequired = "none" | "review-identity" | "review-health" | "review-both";

export interface WelfareCheckResult {
  route: string;
  identityComplete: boolean;
  healthState: RouteHealthState;
  actionRequired: ActionRequired;
}

export interface WelfareCheckReport {
  routes: WelfareCheckResult[];
  totalRoutes: number;
  healthyRoutes: number;
  needsReview: number;
}

function isIdentityComplete(entry: FileRouteEntry): boolean {
  return (
    entry.instructionFile !== undefined &&
    entry.instructionFile.trim() !== "" &&
    entry.role_owner !== undefined &&
    entry.role_owner.trim() !== ""
  );
}

function determineActionRequired(identityComplete: boolean, healthState: RouteHealthState): ActionRequired {
  if (identityComplete && healthState === "healthy") {
    return "none";
  }
  // Note: !identityComplete && healthState === "healthy" is unreachable because
  // assessRouteHealth returns "known-issues" whenever identityComplete is false
  if (identityComplete && healthState !== "healthy") {
    return "review-health";
  }
  return "review-both";
}

export function runWelfareCheck(
  repoRoot: string,
  routePath?: string,
): WelfareCheckReport {
  const config = loadConfig(repoRoot);
  const outputPath = resolve(repoRoot, config.repo.sidecarOutputPath ?? ".polaris/map");

  const routes = readFileRoutes(outputPath);
  const routeHealth = readRouteHealthState(outputPath);

  const results: WelfareCheckResult[] = [];

  for (const [filePath, entry] of Object.entries(routes)) {
    if (routePath && !filePath.startsWith(routePath)) {
      continue;
    }

    const identityComplete = isIdentityComplete(entry);
    const healthState = routeHealth[filePath] ?? assessRouteHealth(entry, repoRoot);
    const actionRequired = determineActionRequired(identityComplete, healthState);

    results.push({
      route: filePath,
      identityComplete,
      healthState,
      actionRequired,
    });
  }

  const healthyRoutes = results.filter((r) => r.actionRequired === "none").length;
  const needsReview = results.filter((r) => r.actionRequired !== "none").length;

  return {
    routes: results,
    totalRoutes: results.length,
    healthyRoutes,
    needsReview,
  };
}

export function printWelfareCheckReport(report: WelfareCheckReport): void {
  console.log(`Route Welfare Check Report`);
  console.log(`========================`);
  console.log(`Total routes: ${report.totalRoutes}`);
  console.log(`Healthy: ${report.healthyRoutes}`);
  console.log(`Needs review: ${report.needsReview}`);
  console.log();

  if (report.routes.length === 0) {
    console.log("No routes found.");
    return;
  }

  for (const result of report.routes) {
    const identityStatus = result.identityComplete ? "✓" : "✗";
    const actionSymbol = result.actionRequired === "none" ? "✓" : "⚠";
    
    console.log(`${actionSymbol} ${result.route}`);
    console.log(`   Identity complete: ${identityStatus}`);
    console.log(`   Health state: ${result.healthState}`);
    console.log(`   Action required: ${result.actionRequired}`);
    console.log();
  }
}