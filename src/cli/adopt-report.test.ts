import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAdoptionReport,
  writeAdoptionReport,
  printAdoptionReport,
} from "./adopt-report.js";

import type { WorkspaceInstallResult } from "./adopt-assets.js";
import type { AgentReconcileRecord } from "./adopt-genesis.js";

describe("adopt-report", () => {
  let repoDir: string;

  afterEach(() => {
    if (existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("buildAdoptionReport aggregates results correctly", () => {
    const install: WorkspaceInstallResult = {
      installed: [".polaris/skills/polaris-run"],
      alreadyPresent: [".polaris/roles/worker.md"],
      skipped: [],
      conflicted: [],
    };
    const graph = { status: "graph-success" as const, stdout: "Symbols: 10" };
    const agents: AgentReconcileRecord[] = [
      {
        file: "CLAUDE.md",
        outcome: "compressed",
        genesisPath: "smartdocs/doctrine/active/2026-06-09-genesis-agent-doctrine.md",
      },
    ];
    const now = new Date("2026-06-09T00:00:00Z");

    const report = buildAdoptionReport({ install, graph, agents, now });

    expect(report.installed).toHaveLength(1);
    expect(report.installed).toContain(".polaris/skills/polaris-run");
    expect(report.alreadyPresent).toHaveLength(1);
    expect(report.alreadyPresent).toContain(".polaris/roles/worker.md");
    expect(report.skipped).toHaveLength(0);
    expect(report.conflicted).toHaveLength(0);
    expect(report.graphStatus).toBe("graph-success");
    expect(report.graphDetail).toBe("Symbols: 10");
    expect(report.graphFollowUp).toBeUndefined();
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0].file).toBe("CLAUDE.md");
    expect(report.agents[0].outcome).toBe("compressed");
    expect(report.timestamp).toBe("2026-06-09T00:00:00.000Z");
  });

  it("writeAdoptionReport writes JSON to correct path", () => {
    repoDir = mkdtempSync(join(tmpdir(), "polaris-report-"));

    const report = buildAdoptionReport({
      install: { installed: [], alreadyPresent: [], skipped: [], conflicted: [] },
      graph: { status: "graph-skipped" as const },
      agents: [],
      now: new Date("2026-06-09T12:00:00Z"),
    });

    writeAdoptionReport(repoDir, report);

    const reportPath = join(repoDir, ".polaris", "runs", "adoption-report-2026-06-09T12-00-00-000Z.json");
    expect(existsSync(reportPath)).toBe(true);

    const fileContent = readFileSync(reportPath, "utf-8");
    const parsed = JSON.parse(fileContent);

    expect(parsed.timestamp).toBe("2026-06-09T12:00:00.000Z");
    expect(parsed.graphStatus).toBe("graph-skipped");
  });

  it("printAdoptionReport does not throw", () => {
    const report = buildAdoptionReport({
      install: {
        installed: [".polaris/skills/polaris-run"],
        alreadyPresent: [".polaris/roles/worker.md"],
        skipped: ["some-skipped-item"],
        conflicted: [],
      },
      graph: {
        status: "graph-failed" as const,
        reason: "Build failed",
        followUpCommand: "polaris-cli graph build",
      },
      agents: [
        {
          file: "CLAUDE.md",
          outcome: "compressed",
          genesisPath: "smartdocs/doctrine/active/2026-06-09-genesis-agent-doctrine.md",
        },
        {
          file: "AGENTS.md",
          outcome: "already-present",
        },
      ],
      now: new Date("2026-06-09T00:00:00Z"),
    });

    // Should not throw
    expect(() => {
      printAdoptionReport(report);
    }).not.toThrow();
  });
});
