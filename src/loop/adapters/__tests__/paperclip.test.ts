import { describe, it, expect } from "vitest";
import { buildCoordsBlock, resolveCoords, PaperclipAdapter } from "../paperclip.js";
import type { BootstrapPacket } from "../types.js";
import type { ExecutionConfig } from "../../../config/schema.js";

const BASE_PACKET: BootstrapPacket = {
  schema_version: "1.0",
  run_id: "run-test-lsc32",
  cluster_id: "LSC-32",
  active_child: "LSC-33",
  state_file: "/tmp/state.json",
  telemetry_file: "/tmp/telemetry.jsonl",
};

const BASE_CONFIG: ExecutionConfig = {
  adapter: "paperclip",
  providers: {},
  paperclip: {
    baseUrl: "https://paperclip.example.com",
    companyId: "co-1",
    assigneeAgentId: "agent-1",
    tokenEnv: "PAPERCLIP_TOKEN",
    runIdEnv: "PAPERCLIP_RUN_ID",
    repoUrl: "https://github.com/example/repo",
    workingDirectory: "/workspace/repo",
    targetPaths: ["src/loop"],
  },
};

describe("buildCoordsBlock", () => {
  it("produces a POLARIS_COORDS HTML comment block with JSON payload", () => {
    const block = buildCoordsBlock({
      repoUrl: "https://github.com/example/repo",
      workingDirectory: "/workspace/repo",
      targetPaths: ["src/loop", "src/config"],
    });
    expect(block).toContain("<!-- POLARIS_COORDS");
    expect(block).toContain("POLARIS_COORDS -->");
    expect(block).toContain('"repoUrl": "https://github.com/example/repo"');
    expect(block).toContain('"workingDirectory": "/workspace/repo"');
    expect(block).toContain('"targetPaths"');
  });

  it("serializes empty targetPaths as an empty array", () => {
    const block = buildCoordsBlock({
      repoUrl: "https://github.com/example/repo",
      workingDirectory: "/workspace/repo",
      targetPaths: [],
    });
    expect(block).toContain('"targetPaths": []');
  });
});

describe("resolveCoords", () => {
  it("uses config values when packet has no repo_coordinates", () => {
    const coords = resolveCoords(BASE_PACKET, BASE_CONFIG);
    expect(coords).not.toBeNull();
    expect(coords!.repoUrl).toBe("https://github.com/example/repo");
    expect(coords!.workingDirectory).toBe("/workspace/repo");
    expect(coords!.targetPaths).toEqual(["src/loop"]);
  });

  it("packet.repo_coordinates takes precedence over config", () => {
    const packet: BootstrapPacket = {
      ...BASE_PACKET,
      repo_coordinates: {
        repoUrl: "https://github.com/example/fork",
        workingDirectory: "/custom/dir",
        targetPaths: ["src/other"],
      },
    };
    const coords = resolveCoords(packet, BASE_CONFIG);
    expect(coords!.repoUrl).toBe("https://github.com/example/fork");
    expect(coords!.workingDirectory).toBe("/custom/dir");
    expect(coords!.targetPaths).toEqual(["src/other"]);
  });

  it("returns null when repoUrl is missing", () => {
    const config: ExecutionConfig = {
      ...BASE_CONFIG,
      paperclip: { ...BASE_CONFIG.paperclip!, repoUrl: undefined },
    };
    expect(resolveCoords(BASE_PACKET, config)).toBeNull();
  });

  it("returns null when workingDirectory is missing", () => {
    const config: ExecutionConfig = {
      ...BASE_CONFIG,
      paperclip: { ...BASE_CONFIG.paperclip!, workingDirectory: undefined },
    };
    expect(resolveCoords(BASE_PACKET, config)).toBeNull();
  });

  it("returns null when paperclip config is absent and packet has no coords", () => {
    const config: ExecutionConfig = { adapter: "paperclip", providers: {} };
    expect(resolveCoords(BASE_PACKET, config)).toBeNull();
  });
});

describe("PaperclipAdapter.dispatch", () => {
  it("fails with missing-coords summary when coords cannot be resolved", async () => {
    const adapter = new PaperclipAdapter({ adapter: "paperclip", providers: {} });
    const result = await adapter.dispatch(BASE_PACKET, { provider: "paperclip" });
    expect(result.pre_dispatch_failure).toBe(true);
    expect(result.summary).toContain("repo coordinates");
  });

  it("builds description with POLARIS_COORDS block when coords are present", async () => {
    const adapter = new PaperclipAdapter(BASE_CONFIG);
    const result = await adapter.dispatch(BASE_PACKET, { provider: "paperclip" });
    // Still fails closed pending LSC-22 HTTP transport
    expect(result.pre_dispatch_failure).toBe(true);
    expect(result.stdout).toContain("<!-- POLARIS_COORDS");
    expect(result.stdout).toContain('"repoUrl"');
    expect(result.stdout).toContain('"workingDirectory"');
    expect(result.stdout).toContain("Active child: LSC-33");
    expect(result.stdout).toContain("Run ID: run-test-lsc32");
  });

  it("embeds packet.repo_coordinates in description when supplied", async () => {
    const adapter = new PaperclipAdapter(BASE_CONFIG);
    const packet: BootstrapPacket = {
      ...BASE_PACKET,
      repo_coordinates: {
        repoUrl: "https://github.com/example/override",
        workingDirectory: "/override/dir",
        targetPaths: ["src/special"],
      },
    };
    const result = await adapter.dispatch(packet, { provider: "paperclip" });
    expect(result.stdout).toContain('"repoUrl": "https://github.com/example/override"');
    expect(result.stdout).toContain('"workingDirectory": "/override/dir"');
  });
});
