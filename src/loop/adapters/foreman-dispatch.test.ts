import { describe, it, expect } from "vitest";
import { dispatchForeman } from "./foreman-dispatch.js";
import { generateSetupBootstrapPacket } from "../../skill-packet/generator.js";
import type { ExecutionConfig } from "../../config/schema.js";

function makeExecutionConfig(providers: Record<string, { command: string; args?: string[] }>): ExecutionConfig {
  return {
    adapter: "terminal-cli",
    providers,
  };
}

describe("dispatchForeman", () => {
  it("dispatches init packet through claude provider (dry-run)", async () => {
    const packet = generateSetupBootstrapPacket("init");
    const config = makeExecutionConfig({
      claude: {
        command: "claude",
        args: ["--print", "{{worker_prompt}}"],
      },
    });

    const result = await dispatchForeman({
      packet,
      provider: "claude",
      executionConfig: config,
      dryRun: true,
    });

    expect(result.exit_code).toBe(0);
    expect(result.provider_used).toBe("claude");
    expect(result.summary).toBe("[dry-run]");
  });

  it("dispatches adopt packet through codex provider (dry-run)", async () => {
    const packet = generateSetupBootstrapPacket("adopt");
    const config = makeExecutionConfig({
      codex: {
        command: "codex",
        args: ["{{worker_prompt}}"],
      },
    });

    const result = await dispatchForeman({
      packet,
      provider: "codex",
      executionConfig: config,
      dryRun: true,
    });

    expect(result.exit_code).toBe(0);
    expect(result.provider_used).toBe("codex");
    expect(result.summary).toBe("[dry-run]");
  });

  it("wraps setup-bootstrap packet with setup run_id and cluster_id", async () => {
    const packet = generateSetupBootstrapPacket("init");
    const config = makeExecutionConfig({
      claude: { command: "echo", args: ["{{run_id}}", "{{cluster_id}}"] },
    });

    const result = await dispatchForeman({
      packet,
      provider: "claude",
      executionConfig: config,
      dryRun: true,
    });

    expect(result.command_run).toContain("setup-init");
  });

  it("throws for unknown provider", async () => {
    const packet = generateSetupBootstrapPacket("init");
    const config = makeExecutionConfig({
      claude: { command: "claude" },
    });

    await expect(
      dispatchForeman({
        packet,
        provider: "nonexistent",
        executionConfig: config,
        dryRun: true,
      }),
    ).rejects.toThrow(/Unknown provider "nonexistent"/);
  });

  it("carries setup-bootstrap packet in context", async () => {
    const packet = generateSetupBootstrapPacket("adopt");
    const config = makeExecutionConfig({
      codex: { command: "echo", args: ["{{packet_json}}"] },
    });

    const result = await dispatchForeman({
      packet,
      provider: "codex",
      executionConfig: config,
      dryRun: true,
    });

    // The dry-run output includes the bootstrap packet JSON which should
    // contain the setup_bootstrap context.
    expect(result.command_run).toContain("setup-bootstrap");
  });

  it("preserves packet_kind and active_role from setup-bootstrap packet", async () => {
    const packet = generateSetupBootstrapPacket("init");
    expect(packet.packet_kind).toBe("setup-bootstrap");
    expect(packet.active_role).toBe("Foreman");

    const config = makeExecutionConfig({
      claude: { command: "echo", args: ["test"] },
    });

    const result = await dispatchForeman({
      packet,
      provider: "claude",
      executionConfig: config,
      dryRun: true,
    });

    expect(result.exit_code).toBe(0);
  });
});
