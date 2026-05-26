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
  const status = vi.fn();
  const continueLoop = vi.fn();
  const queryMap = vi.fn();
  const finalize = vi.fn();
  const program = createPolarisCommand({
    repoRoot: "/repo",
    runLoopStatus: status,
    runLoopContinue: continueLoop,
    runMapQuery: queryMap,
    runFinalize: finalize,
  });

  configureForTest(program, output);

  try {
    await program.parseAsync(["node", "polaris", ...argv], { from: "node" });
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error.code === "commander.helpDisplayed" ||
          error.code === "commander.version")
      )
    ) {
      throw error;
    }
  }

  return { ...output, status, continueLoop, queryMap, finalize };
}

describe("polaris public CLI", () => {
  it("prints root help through Commander", async () => {
    const result = await runCommand(["--help"]);

    expect(result.stdout).toContain("Usage: polaris");
    expect(result.stdout).toContain("loop");
    expect(result.stdout).toContain("map");
    expect(result.stdout).toContain("finalize");
  });

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
});
