import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { TerminalCliAdapter } from "./terminal-cli.js";
import { compileImplPacket } from "../worker-packet.js";

describe("TerminalCliAdapter", () => {
  it("extracts a CompactReturn object even when trailing stdout is non-object JSON", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-terminal-cli-trailing-primitive-"));
    try {
      const resultFile = path.join(tmpDir, "sealed-result.json");
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          devin: {
            command: process.execPath,
            args: [
              "-e",
              "console.log(JSON.stringify({child_id:'POL-14',status:'done',commit:'abc1234',validation:'passed',tracker_updated:false,state_updated:false,telemetry_updated:false,next_recommended_action:'continue'})); console.log(JSON.stringify('.gitignore'));",
            ],
          },
        },
      });
      const packet = compileImplPacket({
        runId: "run-test-0001",
        clusterId: "POL-5",
        childId: "POL-14",
        branch: "feature/pol-14",
        stateFile: "/tmp/polaris-test/current-state.json",
        telemetryFile: "/tmp/polaris-test/telemetry.jsonl",
        resultFile,
        allowedScope: ["src/**"],
        validationCommands: ["npm test"],
      });

      const result = await adapter.dispatch(packet, { provider: "devin" });

      expect(JSON.parse(result.summary ?? "{}")).toEqual({
        child_id: "POL-14",
        status: "done",
        commit: "abc1234",
        validation: "passed",
        tracker_updated: false,
        state_updated: false,
        telemetry_updated: false,
        next_recommended_action: "continue",
      });
      expect(fs.existsSync(resultFile)).toBe(true);
      const written = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
      expect(written).toEqual({
        run_id: "run-test-0001",
        child_id: "POL-14",
        status: "done",
        commit: "abc1234",
        validation: "passed",
        next_recommended_action: "continue",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("seals a failed result when a zero-exit worker emits an unrecognized status", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-terminal-cli-unrecognized-status-"));
    try {
      const resultFile = path.join(tmpDir, "sealed-result.json");
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          devin: {
            command: process.execPath,
            args: [
              "-e",
              "console.log(JSON.stringify({child_id:'POL-14',status:'unknown-status',commit:null,tracker_updated:false,state_updated:false,telemetry_updated:false}));",
            ],
          },
        },
      });
      const packet = compileImplPacket({
        runId: "run-test-0001",
        clusterId: "POL-5",
        childId: "POL-14",
        branch: "feature/pol-14",
        stateFile: "/tmp/polaris-test/current-state.json",
        telemetryFile: "/tmp/polaris-test/telemetry.jsonl",
        resultFile,
        allowedScope: ["src/**"],
        validationCommands: ["npm test"],
      });

      const result = await adapter.dispatch(packet, { provider: "devin" });

      expect(result.exit_code).toBe(0);
      expect(fs.existsSync(resultFile)).toBe(true);
      const written = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
      expect(written["status"]).toBe("failed");
      expect(written["child_id"]).toBe("POL-14");
      expect(written["validation"]).toBe("failed");
      expect(written["next_recommended_action"]).toBe("stop");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
