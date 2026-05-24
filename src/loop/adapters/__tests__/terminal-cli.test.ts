import { describe, it, expect } from "vitest";
import { TerminalCliAdapter } from "../terminal-cli.js";
import { createAdapter } from "../registry.js";
import type { BootstrapPacket } from "../types.js";

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
