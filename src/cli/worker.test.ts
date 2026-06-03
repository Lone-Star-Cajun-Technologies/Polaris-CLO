import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
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

function makeCompletionState(repoRoot: string, childId: string) {
  const stateFile = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  mkdirSync(join(repoRoot, ".taskchain_artifacts", "polaris-run"), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        schema_version: "1.0",
        run_id: "run-001",
        cluster_id: "POL-293",
        skill: "polaris-run",
        branch: "feature/pol-293",
        session_type: "implement",
        active_child: childId,
        completed_children: [],
        open_children: [childId, "POL-295"],
        completed_children_results: {},
        step_cursor: "running",
        context_budget: {
          children_completed: 0,
          max_children_per_session: 5,
        },
        status: "running",
        next_open_child: childId,
        artifact_dir: join(repoRoot, ".taskchain_artifacts", "polaris-run"),
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return stateFile;
}

function makeCommittedResult(repoRoot: string, resultFile: string, childId: string) {
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(join(repoRoot, "src", "complete.ts"), "export const complete = true;\n", "utf-8");
  execFileSync("git", ["add", "src/complete.ts"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", `complete ${childId}`], { cwd: repoRoot, stdio: "ignore" });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();
  writeFileSync(
    resultFile,
    JSON.stringify(
      {
        run_id: "run-001",
        child_id: childId,
        status: "success",
        commit,
        validation: "passed",
      },
      null,
      2,
    ),
    "utf-8",
  );
  return commit;
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

describe("polaris worker complete", () => {
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

  it("updates current-state.json atomically and emits worker-complete telemetry", async () => {
    const childId = "POL-294";
    const stateFile = makeCompletionState(repoRoot, childId);
    const packet = makePacket(repoRoot);
    const resultFile = packet.result_file_contract.result_file;
    const commit = makeCommittedResult(repoRoot, resultFile, childId);
    const packetPath = join(repoRoot, "packet.json");
    writeFileSync(packetPath, JSON.stringify(packet), "utf-8");

    const result = await runPolarisCommand(repoRoot, ["worker", "complete", resultFile], packetPath);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("worker complete failed");

    const savedState = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(savedState["active_child"]).toBe("");
    expect(savedState["open_children"]).not.toContain(childId);
    expect(savedState["completed_children"]).toContain(childId);
    expect((savedState["completed_children_results"] as Record<string, Record<string, unknown>>)[childId]).toMatchObject({
      status: "done",
      validation: "passed",
      commit,
      next_recommended_action: "continue",
    });
    expect(savedState["last_commit"]).toBe(commit);

    const telemetryFile = packet.telemetry_file;
    const events = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((event) => event.event === "worker-complete" && event.commit === commit)).toBe(true);
  });

  it("emits worker-complete-failed and leaves state untouched when the sealed result is invalid", async () => {
    const childId = "POL-294";
    const stateFile = makeCompletionState(repoRoot, childId);
    const packet = makePacket(repoRoot);
    const resultFile = packet.result_file_contract.result_file;
    const packetPath = join(repoRoot, "packet.json");
    writeFileSync(packetPath, JSON.stringify(packet), "utf-8");
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(
      resultFile,
      JSON.stringify(
        {
          run_id: "run-001",
          child_id: childId,
          status: "failure",
          commit: "",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const beforeState = readFileSync(stateFile, "utf-8");
    const result = await runPolarisCommand(repoRoot, ["worker", "complete", resultFile], packetPath);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worker complete rejected");
    expect(readFileSync(stateFile, "utf-8")).toBe(beforeState);

    const telemetryFile = packet.telemetry_file;
    const events = readFileSync(telemetryFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((event) => event.event === "worker-complete-failed")).toBe(true);
  });
});
