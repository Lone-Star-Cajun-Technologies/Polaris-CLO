import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createUpgradeCommand } from "./upgrade-command.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "polaris-upgrade-test-"));
  mkdirSync(join(root, ".polaris"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo", version: "0.0.1" }));
  return root;
}

function captureStdout<T>(fn: () => T): { result: T; stdout: string } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const text = String(chunk);
    chunks.push(text);
    return originalWrite(text, ...(args as [BufferEncoding | undefined, ((err?: Error | null) => void) | undefined]));
  }) as typeof process.stdout.write;
  try {
    return { result: fn(), stdout: chunks.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function runCommand(cmd: ReturnType<typeof createUpgradeCommand>, argv: string[]) {
  let exitCode = 0;
  cmd.exitOverride();
  for (const sub of cmd.commands) {
    sub.exitOverride();
  }
  const { result, stdout } = captureStdout(() =>
    cmd.parseAsync(["node", "polaris", ...argv], { from: "node" }).catch((error) => {
      if (error instanceof Error && "exitCode" in error) {
        exitCode = Number(error.exitCode);
      } else {
        throw error;
      }
    }),
  );
  await result;
  return { exitCode, stdout };
}

describe("upgrade-command", () => {
  it("prints update confirmation when POLARIS_RULES.md is refreshed", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "POLARIS_RULES.md"), "<!-- polaris-version: 0.0.0 -->\n# old", "utf-8");

    const { exitCode, stdout } = await runCommand(createUpgradeCommand({ repoRoot: root }), []);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("POLARIS_RULES.md updated to version");
    rmSync(root, { recursive: true, force: true });
  });

  it("prints already up to date when stamp matches", async () => {
    const root = makeRoot();
    const version = "1.2.3";
    writeFileSync(join(root, "POLARIS_RULES.md"), `<!-- polaris-version: ${version} -->\n# current`, "utf-8");

    const { exitCode, stdout } = await runCommand(
      createUpgradeCommand({ repoRoot: root, getVersion: () => version }),
      [],
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Already up to date (${version})`);
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op on second run", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "POLARIS_RULES.md"), "<!-- polaris-version: 0.0.0 -->\n# old", "utf-8");

    const first = await runCommand(createUpgradeCommand({ repoRoot: root }), []);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("updated to version");

    const second = await runCommand(createUpgradeCommand({ repoRoot: root }), []);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Already up to date");
    rmSync(root, { recursive: true, force: true });
  });

  it("shows a useful description in --help", async () => {
    const root = makeRoot();
    const { exitCode, stdout } = await runCommand(createUpgradeCommand({ repoRoot: root }), ["--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Refresh POLARIS_RULES.md");
    expect(stdout).toContain("-r, --repo-root");
    rmSync(root, { recursive: true, force: true });
  });

  it("propagates refresh errors (top-level CLI exits 1)", async () => {
    const root = makeRoot();
    const cmd = createUpgradeCommand({
      repoRoot: root,
      refresh: () => {
        throw new Error("disk full");
      },
    });

    await expect(cmd.parseAsync(["node", "polaris", "upgrade"], { from: "node" })).rejects.toThrow("disk full");
    rmSync(root, { recursive: true, force: true });
  });

  it("honours --repo-root override", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "POLARIS_RULES.md"), "<!-- polaris-version: 0.0.0 -->\n# old", "utf-8");

    const { exitCode, stdout } = await runCommand(
      createUpgradeCommand({ repoRoot: "/ignored" }),
      ["--repo-root", root],
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("POLARIS_RULES.md updated to version");
    rmSync(root, { recursive: true, force: true });
  });
});
