import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { createQcCommand } from "./qc.js";
import { createPolarisCommand } from "./index.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-qc-cli-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function writeManifest(dir: string, clusterId: string, round: number): string {
  const roundDir = join(dir, ".polaris", "clusters", clusterId, "qc", "repair-rounds", String(round));
  mkdirSync(roundDir, { recursive: true });
  const manifestPath = join(roundDir, "repair-packets.json");
  const manifest = {
    schemaVersion: "1.0",
    clusterId,
    round,
    compiledAt: new Date().toISOString(),
    sourceQcRunIds: ["qc-run-1"],
    packets: [
      {
        packetId: `pkt-${clusterId}-r${round}-001`,
        round,
        clusterId,
        sourceQcRunIds: ["qc-run-1"],
        findingIds: ["f-1", "f-2"],
        severityFloor: "low",
        rootCauseHint: "test",
        allowedScope: ["src/foo.ts"],
        prohibitedScope: [],
        validationCommands: [],
        routingTarget: "operator-review",
        parallelGroup: null,
        conflicts: [],
        medic: true,
        status: "pending",
        createdAt: new Date().toISOString(),
      },
    ],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifestPath;
}

interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(program: Command, argv: string[]): Promise<CommandOutput> {
  const output: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  let exitCode = 0;

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    exitCode = typeof code === "number" ? code : 1;
    throw new Error("process.exit called");
  }) as never);

  program.exitOverride();
  for (const command of program.commands) {
    command.exitOverride();
  }

  try {
    await program.parseAsync(["node", "polaris", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "exitCode" in error && !(error.message === "process.exit called")) {
      exitCode = Number(error.exitCode);
    } else if (error instanceof Error && error.message === "process.exit called") {
      // exitCode already set by the spy
    } else {
      throw error;
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { ...output, exitCode };
}

describe("createQcCommand", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolve rejects missing --reason", async () => {
    const program = new Command("polaris").addCommand(
      createQcCommand({ repoRoot: testDir }),
    );
    writeManifest(testDir, "POL-TEST", 1);

    const result = await runCommand(program, ["qc", "resolve", "--cluster-id", "POL-TEST", "--outcome", "pass"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason");
  });

  it("resolve rejects an empty --reason", async () => {
    const program = new Command("polaris").addCommand(
      createQcCommand({ repoRoot: testDir }),
    );
    writeManifest(testDir, "POL-TEST", 1);

    const result = await runCommand(program, [
      "qc",
      "resolve",
      "--cluster-id",
      "POL-TEST",
      "--outcome",
      "pass",
      "--reason",
      "",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason");
  });

  it("resolve rejects invalid --outcome", async () => {
    const program = new Command("polaris").addCommand(
      createQcCommand({ repoRoot: testDir }),
    );
    writeManifest(testDir, "POL-TEST", 1);

    const result = await runCommand(program, [
      "qc",
      "resolve",
      "--cluster-id",
      "POL-TEST",
      "--outcome",
      "operator-review",
      "--reason",
      "nope",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("outcome");
  });

  it("resolve captures all finding IDs from repair-packets.json when --findings is omitted", async () => {
    const program = new Command("polaris").addCommand(
      createQcCommand({ repoRoot: testDir }),
    );
    writeManifest(testDir, "POL-TEST", 1);

    const result = await runCommand(program, [
      "qc",
      "resolve",
      "--cluster-id",
      "POL-TEST",
      "--outcome",
      "no-repairable",
      "--reason",
      "No capacity to address these findings",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Created resolution artifact");
    expect(result.stdout).toContain("Resolved outcome: no-repairable");

    const resolutionPath = join(
      testDir,
      ".polaris",
      "clusters",
      "POL-TEST",
      "qc",
      "repair-rounds",
      "1",
      "resolution.json",
    );
    expect(readFileSync(resolutionPath, "utf-8")).toContain("f-1");
    const resolution = JSON.parse(readFileSync(resolutionPath, "utf-8")) as Record<string, unknown>;
    expect(resolution.resolvedOutcome).toBe("no-repairable");
    expect(resolution.reason).toBe("No capacity to address these findings");
    expect(resolution.findings).toEqual(["f-1", "f-2"]);
    expect(resolution.resolver).toBe("Test");
  });

  it("resolve restricts findings to explicit --findings list", async () => {
    const program = new Command("polaris").addCommand(
      createQcCommand({ repoRoot: testDir }),
    );
    writeManifest(testDir, "POL-TEST", 1);

    const result = await runCommand(program, [
      "qc",
      "resolve",
      "--cluster-id",
      "POL-TEST",
      "--outcome",
      "pass",
      "--reason",
      "Resolved f-1",
      "--findings",
      "f-1",
    ]);

    expect(result.exitCode).toBe(0);
    const resolutionPath = join(
      testDir,
      ".polaris",
      "clusters",
      "POL-TEST",
      "qc",
      "repair-rounds",
      "1",
      "resolution.json",
    );
    const resolution = JSON.parse(readFileSync(resolutionPath, "utf-8")) as Record<string, unknown>;
    expect(resolution.findings).toEqual(["f-1"]);
  });

  it("resolve errors for an unknown finding id in --findings", async () => {
    const program = new Command("polaris").addCommand(
      createQcCommand({ repoRoot: testDir }),
    );
    writeManifest(testDir, "POL-TEST", 1);

    const result = await runCommand(program, [
      "qc",
      "resolve",
      "--cluster-id",
      "POL-TEST",
      "--outcome",
      "pass",
      "--reason",
      "x",
      "--findings",
      "f-3",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown finding IDs");
  });
});

describe("polaris qc public CLI", () => {
  it("exposes the qc resolve command through the public entrypoint", async () => {
    const program = createPolarisCommand({ repoRoot: "/repo" });
    const result = await runCommand(program, ["qc", "resolve", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: polaris qc resolve");
    expect(result.stdout).toContain("--cluster-id");
    expect(result.stdout).toContain("--outcome");
    expect(result.stdout).toContain("--reason");
    expect(result.stdout).toContain("--findings");
  });
});
