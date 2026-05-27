import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { Command } from "commander";
import { createPolarisCommand } from "./index.js";

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

async function runCommand(argv: string[]) {
  const output = { stdout: "", stderr: "" };
  let exitCode = 0;
  const status = vi.fn();
  const continueLoop = vi.fn();
  const queryMap = vi.fn();
  const finalize = vi.fn();
  const configShow = vi.fn();
  const program = createPolarisCommand({
    repoRoot: "/repo",
    runLoopStatus: status,
    runLoopContinue: continueLoop,
    runMapQuery: queryMap,
    runFinalize: finalize,
    runConfigShow: configShow,
  });

  configureForTest(program, output);

  try {
    await program.parseAsync(["node", "polaris", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof Error && "exitCode" in error) {
      exitCode = Number(error.exitCode);
    } else {
      throw error;
    }
  }

  return { ...output, exitCode, status, continueLoop, queryMap, finalize, configShow };
}

describe("polaris public CLI", () => {
  it("prints root help through Commander", async () => {
    const result = await runCommand(["--help"]);

    expect(result.stdout).toContain("Usage: polaris");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("loop");
    expect(result.stdout).toContain("map");
    expect(result.stdout).toContain("finalize");
    expect(result.stdout).toContain("docs");
    expect(result.stdout).toContain("doctrine");
    expect(result.stdout).toContain("safe/read-only");
    expect(result.stdout).toContain("config");
  });

  it("exposes docs ingest command with expected flags", async () => {
    const result = await runCommand(["docs", "ingest", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: polaris docs ingest");
    expect(result.stdout).toContain("--file");
    expect(result.stdout).toContain("--batch");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("Polaris-Docs/docs");
  });

  it.each(["draft", "promote", "deprecate"])(
    "exposes doctrine %s command through the public entrypoint",
    async (subcommand) => {
      const result = await runCommand(["doctrine", subcommand, "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("unknown command");
      expect(result.stdout).toContain(`Usage: polaris doctrine ${subcommand}`);
    },
  );

  it("prints the package version", async () => {
    const result = await runCommand(["--version"]);

    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps status as a top-level alias for loop status", async () => {
    const result = await runCommand(["status", "--json"]);

    expect(result.status).toHaveBeenCalledWith({
      repoRoot: "/repo",
      stateFile: join("/repo", ".taskchain_artifacts", "polaris-run", "current-state.json"),
      json: true,
    });
  });

  it("routes loop status through the loop command", async () => {
    const result = await runCommand(["loop", "status", "--json"]);

    expect(result.status).toHaveBeenCalledWith({
      repoRoot: "/repo",
      stateFile: join("/repo", ".taskchain_artifacts", "polaris-run", "current-state.json"),
      json: true,
    });
  });

  it("routes map query through the public entrypoint", async () => {
    const result = await runCommand(["map", "query", "src/cli/index.ts"]);

    expect(result.queryMap).toHaveBeenCalledWith(
      "/repo",
      "src/cli/index.ts",
      undefined,
      undefined,
      false,
      false,
    );
  });

  it("exposes finalize run help", async () => {
    const result = await runCommand(["finalize", "run", "--help"]);

    expect(result.stdout).toContain("Usage: polaris finalize run");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--skip-delivery");
  });

  it("prints config help without failing", async () => {
    const result = await runCommand(["config"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: polaris config");
    expect(result.stdout).toContain("show");
    expect(result.stderr).not.toContain("deferred");
  });

  it("routes config show through the public entrypoint", async () => {
    const result = await runCommand(["config", "show"]);

    expect(result.exitCode).toBe(0);
    expect(result.configShow).toHaveBeenCalledWith({
      repoRoot: "/repo",
    });
  });

  it("marks safe previews and mutating commands in subsystem help", async () => {
    const loop = await runCommand(["loop", "--help"]);
    const map = await runCommand(["map", "--help"]);
    const finalize = await runCommand(["finalize", "--help"]);

    expect(loop.exitCode).toBe(0);
    expect(loop.stdout).toContain("status");
    expect(loop.stdout).toContain("safe/read-only");
    expect(loop.stdout).toContain("continue");
    expect(loop.stdout).toContain("mutating");
    expect(loop.stdout).toContain("not a smoke test");

    expect(map.exitCode).toBe(0);
    expect(map.stdout).toContain("--dry-run");
    expect(map.stdout).toContain("non-mutating preview");

    expect(finalize.exitCode).toBe(0);
    expect(finalize.stdout).toContain("manual/operator-triggered");
    expect(finalize.stdout).toContain("performs delivery");
    expect(finalize.stdout).toContain("--dry-run");
    expect(finalize.stdout).toContain("--skip-delivery");
  });

  it("fails unknown commands with actionable help", async () => {
    const result = await runCommand(["not-a-command"]);

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain("Usage: polaris");
    expect(result.stderr).toContain("Commands:");
  });

  it("fails missing subsystem subcommands with actionable help", async () => {
    const result = await runCommand(["loop"]);

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("missing command");
    expect(result.stderr).toContain("Usage: polaris loop");
    expect(result.stderr).toContain("Commands:");
  });

  it("fails unknown subsystem subcommands with actionable help", async () => {
    const result = await runCommand(["loop", "not-a-subcommand"]);

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("unknown command 'not-a-subcommand'");
    expect(result.stderr).toContain("Usage: polaris loop");
    expect(result.stderr).toContain("Commands:");
  });
});
