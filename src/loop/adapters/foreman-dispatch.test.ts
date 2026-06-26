import { describe, it, expect } from "vitest";
import { dispatchForeman } from "./foreman-dispatch.js";
import { generateSetupBootstrapPacket } from "../../skill-packet/generator.js";
import type { ExecutionConfig } from "../../config/schema.js";
import type { SetupBootstrapPacket } from "../../skill-packet/types.js";

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

describe("dispatchForeman — checkpoint gate enforcement", () => {
  const config = makeExecutionConfig({
    claude: { command: "echo", args: ["test"] },
  });

  it("dispatches successfully when checkpoint_gate has self_approval_prohibited: true", async () => {
    const packet = generateSetupBootstrapPacket("init");
    // generateSetupBootstrapPacket always sets self_approval_prohibited: true
    expect(packet.checkpoint_gate.self_approval_prohibited).toBe(true);

    const result = await dispatchForeman({ packet, provider: "claude", executionConfig: config, dryRun: true });
    expect(result.exit_code).toBe(0);
  });

  it("rejects a packet missing checkpoint_gate entirely", async () => {
    const packet = generateSetupBootstrapPacket("init");
    // Simulate a manually constructed packet without checkpoint_gate
    const tampered = { ...packet } as unknown as SetupBootstrapPacket;
    // @ts-expect-error intentionally removing required field for test
    delete tampered.checkpoint_gate;

    await expect(
      dispatchForeman({ packet: tampered, provider: "claude", executionConfig: config, dryRun: true }),
    ).rejects.toThrow(/checkpoint_gate.self_approval_prohibited must be true/);
  });

  it("rejects a packet where self_approval_prohibited is not true", async () => {
    const packet = generateSetupBootstrapPacket("adopt");
    // Simulate a tampered packet with self_approval_prohibited forced to false
    const tampered: SetupBootstrapPacket = {
      ...packet,
      // @ts-expect-error intentionally overriding literal type for test
      checkpoint_gate: { ...packet.checkpoint_gate, self_approval_prohibited: false },
    };

    await expect(
      dispatchForeman({ packet: tampered, provider: "claude", executionConfig: config, dryRun: true }),
    ).rejects.toThrow(/checkpoint_gate.self_approval_prohibited must be true/);
  });

  it("foreman cannot self-approve: gate instruction forbids it for every checkpoint", () => {
    const packet = generateSetupBootstrapPacket("init");
    const checkpoints = packet.approval_checkpoints;
    for (const checkpoint of checkpoints) {
      const gate = packet.checkpoint_gate.gates[checkpoint];
      expect(gate).toContain("You may not self-approve");
    }
  });

  it("all checkpoints produce a halt gate (Foreman must stop at each one)", () => {
    const packet = generateSetupBootstrapPacket("adopt");
    const checkpoints = packet.approval_checkpoints;
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      const gate = packet.checkpoint_gate.gates[checkpoint];
      expect(gate).toContain("HALT");
      expect(gate).toContain("wait for explicit approval");
    }
  });
});
