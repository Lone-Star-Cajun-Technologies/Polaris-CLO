/**
 * Integration tests for src/mcp/tools/current-state.ts
 *
 * Covers:
 * - returns {ok:false, error:"state_not_found"} when file does not exist
 * - returns {ok:true, artifact_dir, state} when file exists with valid JSON
 * - returns {ok:false, error:"parse_error"} when file contains invalid JSON
 * - returns {ok:false, error:"invalid_argument"} for artifact_dir with ".." path traversal
 * - redacts sensitive keys from state
 * - uses "polaris-run" as default artifact_dir
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We mock the root module so resolveRepoRoot() returns our temp dir
vi.mock("../lib/root.js", () => ({
  resolveRepoRoot: vi.fn(),
}));

import { resolveRepoRoot } from "../lib/root.js";
import { handlePolarisCurrentState } from "./current-state.js";

const mockResolveRepoRoot = vi.mocked(resolveRepoRoot);

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `polaris-cs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStateFile(repoRoot: string, artifactDir: string, content: string): void {
  const artifactsDir = join(repoRoot, ".taskchain_artifacts", artifactDir);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "current-state.json"), content);
}

describe("handlePolarisCurrentState()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    mockResolveRepoRoot.mockReturnValue(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns {ok:false, error:'state_not_found'} when the state file does not exist", async () => {
    const result = await handlePolarisCurrentState({ artifact_dir: "my-run" });
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("state_not_found");
  });

  it("returns {ok:true, artifact_dir, state} when the file exists with valid JSON", async () => {
    const state = { status: "running", run_id: "pol-1" };
    writeStateFile(tempDir, "my-run", JSON.stringify(state));

    const result = await handlePolarisCurrentState({ artifact_dir: "my-run" });
    expect(result["ok"]).toBe(true);
    expect(result["artifact_dir"]).toBe("my-run");
    expect(result["state"]).toMatchObject({ status: "running", run_id: "pol-1" });
  });

  it("returns {ok:false, error:'parse_error'} when the file contains invalid JSON", async () => {
    writeStateFile(tempDir, "my-run", "{ this is not valid json }");

    const result = await handlePolarisCurrentState({ artifact_dir: "my-run" });
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("parse_error");
  });

  it("returns {ok:false, error:'invalid_argument'} for artifact_dir containing '..'", async () => {
    const result = await handlePolarisCurrentState({ artifact_dir: "../escape" });
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("invalid_argument");
  });

  it("returns {ok:false, error:'invalid_argument'} for artifact_dir that is just '..'", async () => {
    const result = await handlePolarisCurrentState({ artifact_dir: ".." });
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("invalid_argument");
  });

  it("redacts sensitive keys from the returned state", async () => {
    const state = {
      status: "running",
      token: "super-secret-token",
      password: "hunter2",
      accessToken: "bearer-xyz",
      label: "visible-value",
    };
    writeStateFile(tempDir, "my-run", JSON.stringify(state));

    const result = await handlePolarisCurrentState({ artifact_dir: "my-run" });
    expect(result["ok"]).toBe(true);
    const returnedState = result["state"] as Record<string, unknown>;
    expect(returnedState["token"]).toBe("[redacted]");
    expect(returnedState["password"]).toBe("[redacted]");
    expect(returnedState["accessToken"]).toBe("[redacted]");
    expect(returnedState["label"]).toBe("visible-value");
    expect(returnedState["status"]).toBe("running");
  });

  it("uses 'polaris-run' as default artifact_dir when none provided", async () => {
    // Write the file at the default path
    const state = { run_id: "default-run" };
    writeStateFile(tempDir, "polaris-run", JSON.stringify(state));

    const result = await handlePolarisCurrentState({});
    expect(result["ok"]).toBe(true);
    expect(result["artifact_dir"]).toBe("polaris-run");
    expect((result["state"] as Record<string, unknown>)["run_id"]).toBe("default-run");
  });

  it("uses 'polaris-run' as default when artifact_dir is undefined", async () => {
    const state = { cluster_id: "C-1" };
    writeStateFile(tempDir, "polaris-run", JSON.stringify(state));

    const result = await handlePolarisCurrentState({ artifact_dir: undefined });
    expect(result["ok"]).toBe(true);
    expect(result["artifact_dir"]).toBe("polaris-run");
  });

  it("returns state_not_found with a hint message", async () => {
    const result = await handlePolarisCurrentState({ artifact_dir: "nonexistent-run" });
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("state_not_found");
    expect(typeof result["hint"]).toBe("string");
  });
});
