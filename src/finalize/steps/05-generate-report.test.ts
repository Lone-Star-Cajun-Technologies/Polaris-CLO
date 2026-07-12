import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { stepGenerateReport } from "./05-generate-report.js";
import { resolveTelemetryFilePath } from "../../loop/continue.js";
import type { LoopState } from "../../loop/checkpoint.js";

describe("stepGenerateReport", () => {
  it("reads telemetry events from the shared resolver path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-generate-report-"));
    try {
      const runId = "run-report-test-001";
      const state: LoopState = {
        schema_version: "1.0",
        run_id: runId,
        cluster_id: "POL-1",
        active_child: "POL-544",
        completed_children: [],
        open_children: ["POL-544"],
        step_cursor: null,
        context_budget: { children_completed: 0 },
        status: "running",
        next_open_child: null,
      } as LoopState;

      const telemetryFile = resolveTelemetryFilePath(state, tmpDir);
      fs.mkdirSync(path.dirname(telemetryFile), { recursive: true });
      fs.writeFileSync(
        telemetryFile,
        JSON.stringify({
          event: "provider-selected",
          child_id: "POL-544",
          selected_provider: "devin",
          selection_reason: "policy-router",
        }) + "\n",
        "utf-8",
      );

      const reportPath = stepGenerateReport(tmpDir, state, "feature/pol-544", true);

      expect(reportPath).toBe(path.resolve(tmpDir, ".polaris", "runs", "run-report.md"));
      const report = fs.readFileSync(reportPath, "utf-8");
      expect(report).toContain("POL-544");
      expect(report).toContain("devin");
      expect(report).toContain("policy-router");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
