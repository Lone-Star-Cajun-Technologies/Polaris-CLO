/**
 * Tests for route health assessment (POL-354).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessRouteHealth } from "./route-cognition-delta.js";
import type { FileRouteEntry } from "../map/atlas.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-health-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRouteEntry(overrides: Partial<FileRouteEntry> = {}): FileRouteEntry {
  return {
    domain: "cli",
    route: "src/cli",
    taskchain: "polaris-cli",
    confidence: 0.9,
    classification: "indexed",
    last_updated: new Date().toISOString(),
    updated_by: "test",
    tags: ["cli"],
    instructionFile: "src/cli/POLARIS.md",
    role_owner: "worker",
    ...overrides,
  };
}

describe("assessRouteHealth", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns 'healthy' for fresh, complete route with cognition", () => {
    const entry = makeRouteEntry({
      last_updated: new Date().toISOString(),
      instructionFile: "src/cli/POLARIS.md",
      role_owner: "worker",
    });

    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(join(testDir, "src/cli/POLARIS.md"), "# Test");

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("healthy");
  });

  it("returns 'stale' for entries older than threshold", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100); // 100 days ago

    const entry = makeRouteEntry({
      last_updated: oldDate.toISOString(),
      instructionFile: "src/cli/POLARIS.md",
      role_owner: "worker",
    });

    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(join(testDir, "src/cli/POLARIS.md"), "# Test");

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("stale");
  });

  it("returns 'known-issues' for route missing instructionFile", () => {
    const entry = makeRouteEntry({
      last_updated: new Date().toISOString(),
      instructionFile: undefined,
      role_owner: "worker",
    });

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("known-issues");
  });

  it("returns 'known-issues' for route missing role_owner", () => {
    const entry = makeRouteEntry({
      last_updated: new Date().toISOString(),
      instructionFile: "src/cli/POLARIS.md",
      role_owner: undefined,
    });

    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(join(testDir, "src/cli/POLARIS.md"), "# Test");

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("known-issues");
  });

  it("returns 'known-issues' for route missing both instructionFile and role_owner", () => {
    const entry = makeRouteEntry({
      last_updated: new Date().toISOString(),
      instructionFile: undefined,
      role_owner: undefined,
    });

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("known-issues");
  });

  it("returns 'monitoring' when instructionFile points to missing POLARIS.md", () => {
    const entry = makeRouteEntry({
      last_updated: new Date().toISOString(),
      instructionFile: "src/cli/POLARIS.md",
      role_owner: "worker",
    });

    // Don't create the POLARIS.md file
    mkdirSync(join(testDir, "src/cli"), { recursive: true });

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("monitoring");
  });

  it("returns 'recovering' for recently updated routes (7-30 days ago)", () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 14); // 14 days ago

    const entry = makeRouteEntry({
      last_updated: recentDate.toISOString(),
      instructionFile: "src/cli/POLARIS.md",
      role_owner: "worker",
    });

    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(join(testDir, "src/cli/POLARIS.md"), "# Test");

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("recovering");
  });

  it("returns 'healthy' for very fresh routes (less than 7 days ago)", () => {
    const freshDate = new Date();
    freshDate.setDate(freshDate.getDate() - 3); // 3 days ago

    const entry = makeRouteEntry({
      last_updated: freshDate.toISOString(),
      instructionFile: "src/cli/POLARIS.md",
      role_owner: "worker",
    });

    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(join(testDir, "src/cli/POLARIS.md"), "# Test");

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("healthy");
  });

  it("uses custom stale threshold when provided", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 50); // 50 days ago

    const entry = makeRouteEntry({
      last_updated: oldDate.toISOString(),
      instructionFile: "src/cli/POLARIS.md",
      role_owner: "worker",
    });

    mkdirSync(join(testDir, "src/cli"), { recursive: true });
    writeFileSync(join(testDir, "src/cli/POLARIS.md"), "# Test");

    // With 30-day threshold, 50 days is stale
    const health = assessRouteHealth(entry, testDir, 30);
    expect(health).toBe("stale");
  });

  it("prioritizes staleness over identity issues", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100); // 100 days ago

    const entry = makeRouteEntry({
      last_updated: oldDate.toISOString(),
      instructionFile: undefined, // Missing identity
      role_owner: undefined,
    });

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("stale"); // Staleness takes priority
  });

  it("prioritizes identity issues over missing cognition", () => {
    const entry = makeRouteEntry({
      last_updated: new Date().toISOString(),
      instructionFile: undefined, // Missing identity
      role_owner: "worker",
    });

    const health = assessRouteHealth(entry, testDir, 90);
    expect(health).toBe("known-issues"); // Identity takes priority over cognition check
  });
});