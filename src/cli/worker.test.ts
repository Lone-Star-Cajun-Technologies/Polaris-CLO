import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createPolarisCommand } from "./index.js";
import { compileImplPacket } from "../loop/worker-packet.js";

function configureForTest(program: Command, output: { stdout: string; stderr: string }) {
  program.exitOverride();
  program.configureOutput({
    writeOut: (value) => {
      output.stdout += value;
    },
    writeErr: (value) => {
      output.stderr += value;
    },
  });
  for (const command of program.commands) {
    configureForTest(command, output);
  }
}

function makeRepoRoot(): string {
  const root = join(
    process.cwd(),
    ".taskchain_artifacts",
    `worker-commit-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "copilot@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Copilot"], { cwd: root });
  return root;
}

async function runPolarisCommand(repoRoot: string, argv: string[], packetPath: string) {
  const output = { stdout: "", stderr: "" };
  let exitCode = 0;
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`process.exit(${code})`);
  });

  const previousPacket = process.env.POLARIS_BOOTSTRAP_PACKET;
  process.env.POLARIS_BOOTSTRAP_PACKET = packetPath;

  const program = createPolarisCommand({ repoRoot });
  configureForTest(program, output);

  try {
    await program.parseAsync(["node", "polaris", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "exitCode" in error) {
      exitCode = Number(error.exitCode);
    } else if (error instanceof Error && error.message.startsWith("process.exit(")) {
      // swallow mocked process.exit
    } else {
      throw error;
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    if (previousPacket === undefined) {
      delete process.env.POLARIS_BOOTSTRAP_PACKET;
    } else {
      process.env.POLARIS_BOOTSTRAP_PACKET = previousPacket;
    }
  }

  return { ...output, exitCode };
}

function makePacket(repoRoot: string, overrides?: { allowedScope?: string[]; prohibitedWritePaths?: string[] }) {
  const packet = compileImplPacket({
    runId: "run-001",
    clusterId: "POL-293",
    childId: "POL-294",
    branch: "feature/pol-293",
    stateFile: join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json"),
    telemetryFile: join(repoRoot, ".taskchain_artifacts", "polaris-run", "runs", "run-001", "telemetry.jsonl"),
    resultFile: join(repoRoot, ".polaris", "clusters", "POL-293", "results", "result.json"),
    allowedScope: overrides?.allowedScope ?? ["src/**"],
  });
  if (overrides?.prohibitedWritePaths) {
    packet.prohibited_write_paths = overrides.prohibitedWritePaths;
  }
  return packet;
}

describe("polaris worker commit", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepoRoot();
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("creates a commit and prints its hash for in-scope staged files", async () => {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "worker.ts"), "export const value = 1;\n", "utf-8");
    execFileSync("git", ["add", "src/worker.ts"], { cwd: repoRoot });

    const packet = makePacket(repoRoot, { allowedScope: ["src/**"] });
    const packetPath = join(repoRoot, "packet.json");
    writeFileSync(packetPath, JSON.stringify(packet), "utf-8");

    const result = await runPolarisCommand(repoRoot, ["worker", "commit"], packetPath);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{7,40}$/i);
  });

  it("rejects staged files outside allowed_scope and emits telemetry", async () => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "note.md"), "# note\n", "utf-8");
    execFileSync("git", ["add", "docs/note.md"], { cwd: repoRoot });

    const packet = makePacket(repoRoot, { allowedScope: ["src/**"] });
    const packetPath = join(repoRoot, "packet.json");
    writeFileSync(packetPath, JSON.stringify(packet), "utf-8");

    const result = await runPolarisCommand(repoRoot, ["worker", "commit"], packetPath);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worker commit rejected");
    expect(result.stderr).toContain("out-of-scope:docs/note.md");
    const telemetry = readFileSync(packet.telemetry_file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(telemetry.some((event) => event.event === "worker-commit-rejected")).toBe(true);
  });

  it("rejects staged prohibited paths even when they match allowed_scope", async () => {
    mkdirSync(join(repoRoot, ".taskchain_artifacts", "polaris-run"), { recursive: true });
    writeFileSync(join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json"), "{\"ok\":true}\n", "utf-8");
    execFileSync("git", ["add", ".taskchain_artifacts/polaris-run/current-state.json"], { cwd: repoRoot });

    const packet = makePacket(repoRoot, { allowedScope: ["**/*"] });
    const packetPath = join(repoRoot, "packet.json");
    writeFileSync(packetPath, JSON.stringify(packet), "utf-8");

    const result = await runPolarisCommand(repoRoot, ["worker", "commit"], packetPath);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worker commit rejected");
    expect(result.stderr).toContain("prohibited:.taskchain_artifacts/polaris-run/current-state.json");
    const telemetry = readFileSync(packet.telemetry_file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(telemetry.some((event) => event.event === "worker-commit-rejected")).toBe(true);
  });
});
