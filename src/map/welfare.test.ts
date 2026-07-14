/**
 * Tests for route welfare check (POL-564).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWelfareCheck } from "./welfare.js";
import type { FileRouteEntry } from "./atlas.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-welfare-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRouteEntry(overrides: Partial<FileRouteEntry> = {}): FileRouteEntry {
  return {
    domain: "cognition",
    route: "src/cognition",
    taskchain: "polaris-cognition",
    confidence: 0.9,
    classification: "indexed",
    last_updated: new Date().toISOString(),
    updated_by: "test",
    tags: ["cognition"],
    instructionFile: "src/cognition/POLARIS.md",
    role_owner: "worker",
    ...overrides,
  };
}

describe("runWelfareCheck", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    mkdirSync(join(testDir, ".polaris", "map"), { recursive: true });
    writeFileSync(join(testDir, "polaris.config.json"), JSON.stringify({}), "utf-8");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads persisted route health from route-health.json when available", () => {
    const entry = makeRouteEntry();
    writeFileSync(
      join(testDir, ".polaris", "map", "file-routes.json"),
      JSON.stringify({ "src/cognition/route-cognition-delta.ts": entry }),
      "utf-8",
    );
    writeFileSync(
      join(testDir, ".polaris", "map", "route-health.json"),
      JSON.stringify({ "src/cognition/route-cognition-delta.ts": "monitoring" }),
      "utf-8",
    );

    const report = runWelfareCheck(testDir);

    expect(report.totalRoutes).toBe(1);
    expect(report.routes[0].healthState).toBe("monitoring");
    expect(report.routes[0].identityComplete).toBe(true);
    expect(report.routes[0].actionRequired).toBe("review-health");
    expect(report.needsReview).toBe(1);
    expect(report.healthyRoutes).toBe(0);
  });

  it("falls back to canonical 5-state assessRouteHealth when route-health.json is missing", () => {
    mkdirSync(join(testDir, "src", "cognition"), { recursive: true });
    writeFileSync(join(testDir, "src", "cognition", "POLARIS.md"), "# Cognition", "utf-8");
    const entry = makeRouteEntry();
    writeFileSync(
      join(testDir, ".polaris", "map", "file-routes.json"),
      JSON.stringify({ "src/cognition/route-cognition-delta.ts": entry }),
      "utf-8",
    );

    const report = runWelfareCheck(testDir);

    expect(report.totalRoutes).toBe(1);
    expect(report.routes[0].healthState).toBe("healthy");
    expect(report.routes[0].actionRequired).toBe("none");
    expect(report.healthyRoutes).toBe(1);
    expect(report.needsReview).toBe(0);
  });

  it("filters routes by routePath", () => {
    writeFileSync(
      join(testDir, ".polaris", "map", "file-routes.json"),
      JSON.stringify({
        "src/cognition/route-cognition-delta.ts": makeRouteEntry({
          instructionFile: undefined,
          role_owner: undefined,
        }),
        "src/cli/index.ts": makeRouteEntry({
          route: "src/cli",
          instructionFile: "src/cli/POLARIS.md",
          role_owner: "worker",
        }),
      }),
      "utf-8",
    );

    const report = runWelfareCheck(testDir, "src/cli");

    expect(report.totalRoutes).toBe(1);
    expect(report.routes[0].route).toBe("src/cli/index.ts");
  });

  it("reports known-issues for routes with incomplete identity", () => {
    const entry = makeRouteEntry({
      instructionFile: undefined,
      role_owner: undefined,
    });
    writeFileSync(
      join(testDir, ".polaris", "map", "file-routes.json"),
      JSON.stringify({ "src/cognition/route-cognition-delta.ts": entry }),
      "utf-8",
    );

    const report = runWelfareCheck(testDir);

    expect(report.routes[0].identityComplete).toBe(false);
    expect(report.routes[0].healthState).toBe("known-issues");
    expect(report.routes[0].actionRequired).toBe("review-both");
  });

  it("reports monitoring when instructionFile points to a missing POLARIS.md", () => {
    const entry = makeRouteEntry({
      instructionFile: "src/cognition/POLARIS.md",
      role_owner: "worker",
    });
    writeFileSync(
      join(testDir, ".polaris", "map", "file-routes.json"),
      JSON.stringify({ "src/cognition/route-cognition-delta.ts": entry }),
      "utf-8",
    );

    const report = runWelfareCheck(testDir);

    expect(report.routes[0].healthState).toBe("monitoring");
    expect(report.routes[0].actionRequired).toBe("review-health");
  });
});
