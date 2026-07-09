import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BootstrapPacket } from "./types.js";
import { installCliSubtaskBridge } from "./cli-subtask-bridge.js";
import { loadConfig } from "../../config/loader.js";

const dispatchMock = vi.fn();

vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("./terminal-cli.js", () => ({
  TerminalCliAdapter: vi.fn().mockImplementation(() => ({
    dispatch: dispatchMock,
  })),
}));

function makePacket(): BootstrapPacket {
  return {
    schema_version: "1.0",
    run_id: "run-001",
    cluster_id: "POL-100",
    active_child: "POL-101",
    state_file: "/repo/.taskchain_artifacts/polaris-run/current-state.json",
    telemetry_file: "/repo/.taskchain_artifacts/polaris-run/runs/run-001/telemetry.jsonl",
  };
}

function makePacketWithResultContract(resultFile: string): BootstrapPacket {
  return {
    ...makePacket(),
    result_file_contract: {
      result_file: resultFile,
    },
  } as BootstrapPacket;
}

describe("installCliSubtaskBridge", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    delete (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__;
    delete process.env.POLARIS_NATIVE_SUBTASK_PROVIDER;
    vi.mocked(loadConfig).mockReturnValue({
      execution: {
        adapter: "terminal-cli",
        providers: {
          copilot: {
            command: "copilot",
            args: ["-p", "{{worker_prompt}}"],
          },
          codex: {
            command: "codex",
            args: ["{{worker_prompt}}"],
          },
        },
      },
    } as unknown as ReturnType<typeof loadConfig>);
  });

  it("installs a dispatcher bridge that uses the copilot provider by default", async () => {
    dispatchMock.mockResolvedValue({
      exit_code: 0,
      provider_used: "copilot",
      command_run: "copilot -p prompt",
      summary: "{\"status\":\"done\",\"child_id\":\"POL-101\"}",
    });

    installCliSubtaskBridge("/repo");

    const dispatcher = (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__ as
      | ((
          request: { packet: BootstrapPacket; instructions: string; returnContract: string[] },
        ) => Promise<string | Record<string, unknown>>)
      | undefined;

    expect(dispatcher).toBeTypeOf("function");
    const summary = await dispatcher!({
      packet: makePacket(),
      instructions: "worker instructions",
      returnContract: ["child_id", "status"],
    });

    expect(dispatchMock).toHaveBeenCalledWith(makePacket(), { provider: "copilot" });
    expect(summary).toEqual({ status: "done", child_id: "POL-101" });
  });

  it("uses POLARIS_NATIVE_SUBTASK_PROVIDER when configured", async () => {
    process.env.POLARIS_NATIVE_SUBTASK_PROVIDER = "codex";
    dispatchMock.mockResolvedValue({
      exit_code: 0,
      provider_used: "codex",
      command_run: "codex prompt",
      summary: "{\"status\":\"done\",\"child_id\":\"POL-101\"}",
    });

    installCliSubtaskBridge("/repo");

    const dispatcher = (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__ as
      | ((
          request: { packet: BootstrapPacket; instructions: string; returnContract: string[] },
        ) => Promise<string | Record<string, unknown>>)
      | undefined;

    await dispatcher!({
      packet: makePacket(),
      instructions: "worker instructions",
      returnContract: ["child_id", "status"],
    });

    expect(dispatchMock).toHaveBeenCalledWith(makePacket(), { provider: "codex" });
  });

  it("does not install a dispatcher when no supported provider is configured", () => {
    vi.mocked(loadConfig).mockReturnValue({
      execution: {
        adapter: "terminal-cli",
        providers: {
          claude: { command: "claude", args: ["{{worker_prompt}}"] },
        },
      },
    } as unknown as ReturnType<typeof loadConfig>);

    installCliSubtaskBridge("/repo");

    expect((globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__).toBeUndefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("surfaces provider errors through the bridge", async () => {
    dispatchMock.mockResolvedValue({
      exit_code: 1,
      provider_used: "copilot",
      command_run: "copilot -p prompt",
      summary: "failed",
      stderr: "boom",
    });

    installCliSubtaskBridge("/repo");
    const dispatcher = (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__ as
      | ((
          request: { packet: BootstrapPacket; instructions: string; returnContract: string[] },
        ) => Promise<string | Record<string, unknown>>)
      | undefined;

    await expect(
      dispatcher!({
        packet: makePacket(),
        instructions: "worker instructions",
        returnContract: ["child_id", "status"],
      }),
    ).rejects.toThrow("CLI subtask bridge provider \"copilot\" failed");
  });

  it("writes sealed result files when result_file_contract is present", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "polaris-bridge-test-"));
    const resultFile = join(tempDir, "result", "sealed.json");
    dispatchMock.mockResolvedValue({
      exit_code: 0,
      provider_used: "copilot",
      command_run: "copilot -p prompt",
      summary: JSON.stringify({
        status: "done",
        child_id: "POL-101",
        commit_hash: "abc123",
        validation: "npm test",
      }),
    });

    installCliSubtaskBridge("/repo");
    const dispatcher = (globalThis as Record<string, unknown>).__POLARIS_AGENT_SUBTASK_DISPATCH__ as
      | ((
          request: { packet: BootstrapPacket; instructions: string; returnContract: string[] },
        ) => Promise<string | Record<string, unknown>>)
      | undefined;

    await dispatcher!({
      packet: makePacketWithResultContract(resultFile),
      instructions: "worker instructions",
      returnContract: ["child_id", "status"],
    });

    const sealed = JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
    expect(sealed).toEqual({
      run_id: "run-001",
      cluster_id: "POL-100",
      child_id: "POL-101",
      status: "success",
      next_recommended_action: "continue",
      commit: "abc123",
      validation: "npm test",
    });
    rmSync(tempDir, { recursive: true, force: true });
  });
});
