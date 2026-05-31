import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { CANONICAL_TARGET } from "./ingest.js";
import { createDocsCommand } from "./index.js";

function makeRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "polaris-docs-init-"));
  mkdirSync(join(repoRoot, ".polaris", "map"), { recursive: true });
  writeFileSync(
    join(repoRoot, "polaris.config.json"),
    JSON.stringify({ repo: { sidecarOutputPath: ".polaris/map" } }),
    "utf-8",
  );
  writeFileSync(join(repoRoot, ".polaris", "map", "file-routes.json"), "{}\n", "utf-8");
  writeFileSync(join(repoRoot, ".polaris", "map", "needs-review.json"), "{}\n", "utf-8");
  return repoRoot;
}

function configureForTest(command: Command, output: { stdout: string; stderr: string }): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (value) => {
      output.stdout += value;
    },
    writeErr: (value) => {
      output.stderr += value;
    },
  });
  for (const subcommand of command.commands) {
    configureForTest(subcommand, output);
  }
}

async function runDocsCommand(repoRoot: string, argv: string[]) {
  const output = { stdout: "", stderr: "" };
  const command = createDocsCommand({ repoRoot });
  configureForTest(command, output);
  const log = vi.spyOn(console, "log").mockImplementation((value = "") => {
    output.stdout += `${String(value)}\n`;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((value = "") => {
    output.stderr += `${String(value)}\n`;
  });
  const error = vi.spyOn(console, "error").mockImplementation((value = "") => {
    output.stderr += `${String(value)}\n`;
  });

  try {
    await command.parseAsync(["node", "polaris", ...argv], { from: "node" });
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }

  return output;
}

describe("docs init command", () => {
  it("dry-runs the Smart Docs scaffold without creating directories", async () => {
    const repoRoot = makeRepo();

    const output = await runDocsCommand(repoRoot, ["init", "--dry-run"]);

    expect(output.stdout).toContain("[dry-run] would create");
    expect(output.stdout).toContain(`${CANONICAL_TARGET}/raw`);
    expect(existsSync(join(repoRoot, CANONICAL_TARGET))).toBe(false);
  });

  it("creates the Smart Docs scaffold and is idempotent", async () => {
    const repoRoot = makeRepo();

    const first = await runDocsCommand(repoRoot, ["init"]);
    const second = await runDocsCommand(repoRoot, ["init"]);

    expect(first.stdout).toContain("created");
    expect(first.stdout).toContain(`${CANONICAL_TARGET}/doctrine/active`);
    expect(second.stdout).toContain("already exists");
    expect(existsSync(join(repoRoot, CANONICAL_TARGET, "runtime", "summaries"))).toBe(true);
    expect(existsSync(join(repoRoot, CANONICAL_TARGET, "raw"))).toBe(true);
    expect(existsSync(join(repoRoot, CANONICAL_TARGET, "doctrine", "active"))).toBe(true);
  });

  it("unblocks docs ingest after initialization", async () => {
    const repoRoot = makeRepo();
    await runDocsCommand(repoRoot, ["init"]);
    writeFileSync(
      join(repoRoot, "smartdocs", "raw", "smart-docs.md"),
      "# Smart Docs Spec\n\nAcceptance Criteria\n",
      "utf-8",
    );
    const output = await runDocsCommand(repoRoot, ["ingest", "--file", "smartdocs/raw/smart-docs.md"]);

    expect(output.stdout).toContain(`${CANONICAL_TARGET}/raw/smart-docs.md`);
    expect(existsSync(join(repoRoot, CANONICAL_TARGET, "raw", "smart-docs.md"))).toBe(true);
  });
});
