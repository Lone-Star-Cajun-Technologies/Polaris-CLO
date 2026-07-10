import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { TerminalCliAdapter } from "../terminal-cli.js";
import { createAdapter } from "../registry.js";
import type { BootstrapPacket } from "../types.js";
import { compileImplPacket, compileRepairWorkerPacket } from "../../worker-packet.js";

const MOCK_PACKET: BootstrapPacket = {
  schema_version: "1.0",
  run_id: "run-test-0001",
  cluster_id: "POL-5",
  active_child: "POL-14",
  state_file: "/tmp/polaris-test/current-state.json",
  telemetry_file: "/tmp/polaris-test/telemetry.jsonl",
};

describe("TerminalCliAdapter", () => {
  describe("provider resolution", () => {
    it("throws for unknown provider with list of available ones", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: { command: "codex" },
          gemini: { command: "gemini" },
        },
      });
      await expect(
        adapter.dispatch(MOCK_PACKET, { provider: "windsurf", dryRun: true })
      ).rejects.toThrow(/Unknown provider "windsurf".*codex.*gemini/);
    });

    it("includes helpful message when no providers are configured", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {},
      });
      await expect(
        adapter.dispatch(MOCK_PACKET, { provider: "codex", dryRun: true })
      ).rejects.toThrow(/No providers configured/);
    });
  });

  describe("command expansion", () => {
    it("expands $ENV_VAR references in command", async () => {
      process.env.POLARIS_AGENT = "/usr/local/bin/myagent";
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: { custom: { command: "$POLARIS_AGENT", args: ["{{active_child}}"] } },
      });
      const result = await adapter.dispatch(MOCK_PACKET, { provider: "custom", dryRun: true });
      expect(result.command_run).toContain("/usr/local/bin/myagent");
      expect(result.command_run).toContain("POL-14");
      delete process.env.POLARIS_AGENT;
    });

    it("throws when command expands to an unset $VAR", async () => {
      delete process.env.POLARIS_MISSING_VAR;
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: { custom: { command: "$POLARIS_MISSING_VAR" } },
      });
      await expect(
        adapter.dispatch(MOCK_PACKET, { provider: "custom", dryRun: true })
      ).rejects.toThrow(/unset environment variable|empty string/);
    });

    it("substitutes {{template}} variables in args", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: {
            command: "echo",
            args: ["child={{active_child}}", "run={{run_id}}"],
          },
        },
      });
      const result = await adapter.dispatch(MOCK_PACKET, { provider: "codex", dryRun: true });
      expect(result.command_run).toContain("child=POL-14");
      expect(result.command_run).toContain("run=run-test-0001");
    });

    it("substitutes {{worker_prompt}} with compiled worker instructions", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          claude: {
            command: "echo",
            args: ["{{worker_prompt}}"],
          },
        },
      });
      const result = await adapter.dispatch(MOCK_PACKET, { provider: "claude", dryRun: true });
      expect(result.command_run).toContain("You are the dedicated Polaris worker subagent");
      expect(result.command_run).not.toContain('"schema_version":"1.0"');
    });

    it("writes a sealed result file from compact stdout when requested", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-terminal-cli-test-"));
      try {
        const resultFile = path.join(tmpDir, "sealed-result.json");
        const adapter = new TerminalCliAdapter({
          adapter: "terminal-cli",
          providers: {
            claude: {
              command: process.execPath,
              args: [
                "-e",
                "console.log(JSON.stringify({child_id:'POL-14',status:'done',commit:'abc1234',validation:'passed',tracker_updated:false,state_updated:false,telemetry_updated:false,next_recommended_action:'continue'}))",
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

        await adapter.dispatch(packet, { provider: "claude" });

        expect(fs.existsSync(resultFile)).toBe(true);
        const written = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
        expect(written).toEqual({
          run_id: "run-test-0001",
          child_id: "POL-14",
          status: "success",
          commit: "abc1234",
          validation: "passed",
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("blocks impl packets with empty allowed_scope", async () => {
      const packet = compileImplPacket({
        runId: "run-test-0001",
        clusterId: "POL-5",
        childId: "POL-14",
        branch: "feature/pol-14",
        stateFile: "/tmp/polaris-test/current-state.json",
        telemetryFile: "/tmp/polaris-test/telemetry.jsonl",
        resultFile: "/tmp/polaris-test/result.json",
        allowedScope: [],
        validationCommands: ["npm test"],
      });
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: { command: "echo", args: ["--child", "{{active_child}}"] },
        },
      });

      const result = await adapter.dispatch(packet, { provider: "codex", dryRun: true });

      expect(result.exit_code).toBe(1);
      expect(result.provider_used).toBe("codex");
      expect(result.stderr).toContain("empty allowed_scope");
      expect(JSON.parse(result.summary ?? "{}")).toMatchObject({
        child_id: "POL-14",
        status: "blocked",
        warnings: ["empty-allowed-scope"],
      });
    });

    it("blocks repair packets with empty allowed_scope", async () => {
      const packet = compileRepairWorkerPacket({
        runId: "run-test-0001",
        clusterId: "POL-5",
        packetId: "POL-REPAIR",
        branch: "feature/pol-repair",
        stateFile: "/tmp/polaris-test/current-state.json",
        telemetryFile: "/tmp/polaris-test/telemetry.jsonl",
        round: 1,
        allowedScope: [],
        prohibitedScope: [],
        validationCommands: ["npm test"],
        rootCauseHint: "empty-scope repair packet",
        resultFile: "/tmp/polaris-test/result.json",
      });
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: { command: "echo", args: ["--child", "{{active_child}}"] },
        },
      });

      const result = await adapter.dispatch(packet, { provider: "codex", dryRun: true });

      expect(result.exit_code).toBe(1);
      expect(result.provider_used).toBe("codex");
      expect(result.stderr).toContain("empty allowed_scope");
      expect(JSON.parse(result.summary ?? "{}")).toMatchObject({
        child_id: "POL-REPAIR",
        status: "blocked",
        warnings: ["empty-allowed-scope"],
      });
    });
  });

  describe("dry-run", () => {
    it("returns exit_code 0 and summary [dry-run] without spawning a process", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: { command: "does-not-exist-binary", args: ["--child", "{{active_child}}"] },
        },
      });
      const result = await adapter.dispatch(MOCK_PACKET, { provider: "codex", dryRun: true });
      expect(result.exit_code).toBe(0);
      expect(result.summary).toBe("[dry-run]");
      expect(result.provider_used).toBe("codex");
    });
  });

  describe("fallback and failure classification", () => {
    it("falls back on command-not-found pre-dispatch failure", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: { command: "definitely-missing-command-pol-468" },
          gemini: {
            command: process.execPath,
            args: [
              "-e",
              "console.log(JSON.stringify({child_id:'POL-14',status:'done',commit:'ok',validation:'passed',tracker_updated:false,state_updated:false,telemetry_updated:false,next_recommended_action:'continue'}))",
            ],
          },
        },
        providerPolicy: {
          worker: {
            providers: ["gemini"],
          },
        },
      });

      const result = await adapter.dispatch(MOCK_PACKET, {
        provider: "codex",
        routerDecision: {
          selectedProvider: "codex",
          selectionReason: "policy-router",
          providersTried: ["codex", "gemini"],
        },
      });

      expect(result.exit_code).toBe(0);
      expect(result.provider_used).toBe("gemini");
      expect(result.router_evidence?.selectionReason).toBe("policy-router");
      expect(result.provider_attempts?.[0]).toMatchObject({
        provider: "codex",
        failure_origin: "provider-launch",
        failure_category: "provider-unavailable",
        pre_dispatch_failure: true,
        fallback_eligible: true,
      });
    });

    it("classifies rate-limit failures as quota-exhausted and falls back", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: {
            command: process.execPath,
            args: ["-e", "console.error('Rate limit exceeded (429)'); process.exit(1);"],
          },
          gemini: {
            command: process.execPath,
            args: [
              "-e",
              "console.log(JSON.stringify({child_id:'POL-14',status:'done',commit:'ok',validation:'passed',tracker_updated:false,state_updated:false,telemetry_updated:false,next_recommended_action:'continue'}))",
            ],
          },
        },
        providerPolicy: {
          worker: {
            providers: ["gemini"],
          },
        },
      });

      const result = await adapter.dispatch(MOCK_PACKET, {
        provider: "codex",
        routerDecision: {
          selectedProvider: "codex",
          selectionReason: "policy-router",
          providersTried: ["codex", "gemini"],
        },
      });

      expect(result.exit_code).toBe(0);
      expect(result.provider_used).toBe("gemini");
      expect(result.provider_attempts?.[0]).toMatchObject({
        provider: "codex",
        failure_origin: "provider-launch",
        failure_category: "quota-exhausted",
        pre_dispatch_failure: true,
      });
    });

    it("respects provider policy noFallback and does not retry", async () => {
      const adapter = new TerminalCliAdapter({
        adapter: "terminal-cli",
        providers: {
          codex: { command: "definitely-missing-command-pol-468" },
          gemini: { command: "echo", args: ["should-not-run"] },
        },
        providerPolicy: {
          worker: {
            noFallback: true,
            providers: ["gemini"],
          },
        },
      });

      const result = await adapter.dispatch(MOCK_PACKET, {
        provider: "codex",
        routerDecision: {
          selectedProvider: "codex",
          selectionReason: "policy-router",
          providersTried: ["codex", "gemini"],
        },
      });

      expect(result.exit_code).toBe(1);
      expect(result.provider_used).toBe("codex");
      expect(result.failure_category).toBe("provider-unavailable");
      expect(result.provider_attempts).toHaveLength(1);
    });

    it("does not retry when a sealed result file already exists", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-terminal-cli-retry-"));
      try {
        const packet = compileImplPacket({
          runId: "run-test-0001",
          clusterId: "POL-5",
          childId: "POL-14",
          branch: "feature/pol-14",
          stateFile: "/tmp/polaris-test/current-state.json",
          telemetryFile: "/tmp/polaris-test/telemetry.jsonl",
          resultFile: path.join(tmpDir, "sealed-result.json"),
          allowedScope: ["src/**"],
          validationCommands: ["npm test"],
        });
        const adapter = new TerminalCliAdapter({
          adapter: "terminal-cli",
          providers: {
            codex: {
              command: process.execPath,
              args: [
                "-e",
                [
                  "const fs=require('node:fs');",
                  "const p=JSON.parse(process.env.POLARIS_PACKET_JSON||'{}');",
                  "const out=p.result_file_contract?.result_file;",
                  "if(out){fs.mkdirSync(require('node:path').dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({run_id:p.run_id,child_id:p.active_child,status:'failure',error_message:'intentional'}));}",
                  "process.exit(1);",
                ].join(""),
              ],
            },
            gemini: {
              command: process.execPath,
              args: ["-e", "console.log('secondary should not run'); process.exit(0);"],
            },
          },
          providerPolicy: {
            worker: {
              providers: ["gemini"],
            },
          },
        });

        const result = await adapter.dispatch(packet, { provider: "codex" });
        expect(result.exit_code).toBe(1);
        expect(result.provider_used).toBe("codex");
        expect(result.failure_origin).toBe("worker-execution");
        expect(result.fallback_eligible).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe("registry", () => {
  it("createAdapter returns TerminalCliAdapter for terminal-cli", () => {
    const adapter = createAdapter("terminal-cli", { adapter: "terminal-cli", providers: {} });
    expect(adapter.name).toBe("terminal-cli");
  });

  it("createAdapter throws for unknown adapter", () => {
    expect(() => createAdapter("not-a-real-adapter", { adapter: "not-a-real-adapter", providers: {} })).toThrow(
      /Unknown adapter/,
    );
  });
});
