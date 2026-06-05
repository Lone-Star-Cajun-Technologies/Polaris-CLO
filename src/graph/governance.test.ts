import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { PolarisConfig } from "../config/schema.js";
import { checkGraphInvalidation, writeGraphNotices } from "./governance.js";

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
}

function createRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-graph-governance-"));
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "user.email", "graph@example.com"]);
  git(repoRoot, ["config", "user.name", "Graph Governance"]);
  writeFileSync(join(repoRoot, "README.md"), "seed\n", "utf-8");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-m", "seed"]);
  return repoRoot;
}

function baseConfig(): PolarisConfig {
  return {
    version: "1.0",
    graph: {
      outputPath: ".polaris/graph",
      invalidationTriggers: ["repo-change", "config-change"],
    },
  };
}

describe("writeGraphNotices", () => {
  it("writes NOTICES and is idempotent on repeat writes", () => {
    const out = mkdtempSync(join(tmpdir(), "polaris-notices-"));
    const notices = [
      "Copyright (c) MIT Component A",
      "Copyright (c) MIT Component B",
    ];

    writeGraphNotices(out, notices);
    const first = readFileSync(join(out, "NOTICES"), "utf-8");
    writeGraphNotices(out, notices);
    const second = readFileSync(join(out, "NOTICES"), "utf-8");

    expect(first).toBe("# NOTICES\n\nCopyright (c) MIT Component A\n\nCopyright (c) MIT Component B\n");
    expect(second).toBe(first);
  });
});

describe("checkGraphInvalidation", () => {
  it('returns stale config-change when config hash changes and trigger is enabled', () => {
    const repoRoot = createRepo();
    const config = baseConfig();

    expect(checkGraphInvalidation(config, repoRoot)).toEqual({ stale: false });

    const changedConfig: PolarisConfig = {
      ...config,
      repo: { name: "changed-name" },
    };
    expect(checkGraphInvalidation(changedConfig, repoRoot)).toEqual({
      stale: true,
      reason: "config-change",
    });
  });

  it('returns stale repo-change when HEAD changes and trigger is enabled', () => {
    const repoRoot = createRepo();
    const config = baseConfig();

    expect(checkGraphInvalidation(config, repoRoot)).toEqual({ stale: false });
    writeFileSync(join(repoRoot, "README.md"), "updated\n", "utf-8");
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["commit", "-m", "update"]);

    expect(checkGraphInvalidation(config, repoRoot)).toEqual({
      stale: true,
      reason: "repo-change",
    });
  });

  it("returns stale false when tracked state is unchanged", () => {
    const repoRoot = createRepo();
    const config = baseConfig();

    expect(checkGraphInvalidation(config, repoRoot)).toEqual({ stale: false });
    expect(checkGraphInvalidation(config, repoRoot)).toEqual({ stale: false });
  });
});
