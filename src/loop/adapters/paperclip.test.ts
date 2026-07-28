import { describe, it, expect } from "vitest";
import { PaperclipAdapter } from "./paperclip.js";
import type { BootstrapPacket } from "./types.js";

const MOCK_PACKET: BootstrapPacket = {
  schema_version: "1.0",
  run_id: "run-test-0001",
  cluster_id: "POL-5",
  active_child: "POL-14",
  state_file: "/tmp/polaris-test/current-state.json",
  telemetry_file: "/tmp/polaris-test/telemetry.jsonl",
};

describe("PaperclipAdapter", () => {
  it("has name 'paperclip'", () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    expect(adapter.name).toBe("paperclip");
  });

  it("dispatch() fails closed with pre_dispatch_failure: true", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    const result = await adapter.dispatch(MOCK_PACKET, { provider: "paperclip" });

    expect(result).toEqual({
      exit_code: 1,
      provider_used: "paperclip",
      command_run: "",
      pre_dispatch_failure: true,
      failure_origin: "provider-launch",
      failure_category: "provider-unavailable",
      fallback_eligible: false,
      summary: "Paperclip adapter transport not yet implemented (pending LSC-22).",
    });
  });

  it("mentions the pending LSC-22 work in the summary", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    const result = await adapter.dispatch(MOCK_PACKET, { provider: "paperclip" });
    expect(result.summary).toContain("LSC-22");
    expect(result.summary).toContain("not yet implemented");
  });

  it("is marked as not eligible for fallback (fail-closed, not fail-open)", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    const result = await adapter.dispatch(MOCK_PACKET, { provider: "paperclip" });
    expect(result.fallback_eligible).toBe(false);
  });

  it("returns the same fail-closed shape regardless of packet content", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    const emptyPacket: BootstrapPacket = {
      schema_version: "1.0",
      run_id: "",
      cluster_id: "",
      active_child: "",
      state_file: "",
      telemetry_file: "",
    };

    const result = await adapter.dispatch(emptyPacket, { provider: "paperclip" });
    expect(result.exit_code).toBe(1);
    expect(result.pre_dispatch_failure).toBe(true);
  });

  it("returns the same fail-closed shape regardless of the requested provider option", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });

    const result = await adapter.dispatch(MOCK_PACKET, { provider: "some-other-provider" });

    // The adapter always reports itself as the provider used, ignoring the
    // caller-requested provider name (Paperclip is its own provider).
    expect(result.provider_used).toBe("paperclip");
  });

  it("does not throw or execute anything for dryRun requests (stub short-circuits before any launch)", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    await expect(
      adapter.dispatch(MOCK_PACKET, { provider: "paperclip", dryRun: true }),
    ).resolves.toMatchObject({ pre_dispatch_failure: true });
  });

  it("ignores unrelated provider configuration passed via ExecutionConfig", async () => {
    const adapter = new PaperclipAdapter({
      adapter: "paperclip",
      providers: {
        codex: { command: "codex" },
        claude: { command: "claude" },
      },
    });

    const result = await adapter.dispatch(MOCK_PACKET, { provider: "codex" });
    expect(result.provider_used).toBe("paperclip");
    expect(result.exit_code).toBe(1);
  });

  it("does not implement an optional probe() method", () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    expect(adapter.probe).toBeUndefined();
  });

  it("produces independent results across repeated calls (stateless dispatch)", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    const first = await adapter.dispatch(MOCK_PACKET, { provider: "paperclip" });
    const second = await adapter.dispatch(MOCK_PACKET, { provider: "paperclip" });
    expect(first).toEqual(second);
  });

  it("does not mutate the packet or config it was constructed with", async () => {
    const config = { adapter: "paperclip", providers: { codex: { command: "codex" } } };
    const configSnapshot = JSON.parse(JSON.stringify(config));
    const packetSnapshot = JSON.parse(JSON.stringify(MOCK_PACKET));

    const adapter = new PaperclipAdapter(config);
    await adapter.dispatch(MOCK_PACKET, { provider: "paperclip" });

    expect(config).toEqual(configSnapshot);
    expect(MOCK_PACKET).toEqual(packetSnapshot);
  });
});