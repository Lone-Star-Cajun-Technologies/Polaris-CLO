import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createSolCommand, createAutoresearchCommand } from "./autoresearch.js";

let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makeReportRepo(runId: string): string {
  tempRoot = mkdtempSync(join(tmpdir(), "polaris-sol-report-"));
  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ name: "@lsctech/polaris", version: "0.0.0" }, null, 2),
  );
  execFileSync("git", ["init", "-q"], { cwd: tempRoot });
  execFileSync("git", ["config", "user.email", "copilot@example.com"], { cwd: tempRoot });
  execFileSync("git", ["config", "user.name", "Copilot"], { cwd: tempRoot });

  const runDir = join(tempRoot, ".taskchain_artifacts", "polaris-run", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "telemetry.jsonl"), "", "utf-8");

  const currentStatePath = join(tempRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  mkdirSync(join(tempRoot, ".taskchain_artifacts", "polaris-run"), { recursive: true });
  writeFileSync(
    currentStatePath,
    JSON.stringify(
      {
        run_id: runId,
        cluster_id: "POL-100",
        status: "done",
        completed_children_results: {
          "POL-001": {
            run_id: runId,
            cluster_id: "POL-100",
            child_id: "POL-001",
            status: "done",
            validation: "passed",
            commit: "abc1234",
            next_recommended_action: "continue",
            role: "worker",
            provider: "devin",
            skill_name: "polaris-run",
            packet_hash: "hash1",
            worker_id: "worker-001",
            escalation_count: 0,
            heartbeat_count: 2,
            changed_files: ["src/example.ts"],
            dispatch_epoch: 1,
            user_intervened: false,
            foreman_intervened: false,
            result_data: { model: "claude-3-7-sonnet", task_type: "implementation" },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  mkdirSync(join(tempRoot, ".polaris", "clusters", "POL-100", "results"), { recursive: true });
  return tempRoot;
}

describe("createSolCommand", () => {
  it("returns a 'sol' command with 'score', 'propose', and 'recommend' subcommands", () => {
    const command = createSolCommand({ repoRoot: "/tmp/polaris-test" });
    expect(command.name()).toBe("sol");
    const subcommands = command.commands.map((c) => c.name());
    expect(subcommands).toContain("score");
    expect(subcommands).toContain("propose");
    expect(subcommands).toContain("recommend");
  });

  it("exposes the configured repo root as the default", () => {
    const command = createSolCommand({ repoRoot: "/custom/root" });
    const score = command.commands.find((c) => c.name() === "score");
    expect(score).toBeDefined();
    expect(score!.opts().repoRoot).toBe("/custom/root");
  });

  it("exposes the report subcommand", () => {
    const command = createSolCommand({ repoRoot: "/tmp/polaris-test" });
    const subcommands = command.commands.map((c) => c.name());
    expect(subcommands).toContain("report");
  });

  it("keeps 'autoresearch' as a compatibility alias", () => {
    const command = createSolCommand({ repoRoot: "/tmp/polaris-test" });
    expect(command.alias()).toBe("autoresearch");
  });
});

describe("createAutoresearchCommand", () => {
  it("remains an alias for createSolCommand", () => {
    const command = createAutoresearchCommand({ repoRoot: "/tmp/polaris-test" });
    expect(command.name()).toBe("sol");
    expect(command.alias()).toBe("autoresearch");
  });
});

describe("sol report command", () => {
  it("advertises --format and --no-write flags in help", () => {
    const command = createSolCommand({ repoRoot: "/tmp/polaris-test" });
    const report = command.commands.find((c) => c.name() === "report");
    expect(report).toBeDefined();

    const help = report!.helpInformation();
    expect(help).toContain("--format");
    expect(help).toContain("--no-write");
    expect(help).toContain("--json");
  });

  it("executes the report action and keeps written evaluation artifacts in sync with JSON output", async () => {
    const runId = "run-report-001";
    const repoRoot = makeReportRepo(runId);
    const command = createSolCommand({ repoRoot });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    try {
      await command.parseAsync(["node", "sol", "report", runId, "--repo-root", repoRoot, "--json"], { from: "node" });
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(stderr.join("")).toBe("");
    const parsed = JSON.parse(stdout.join("")) as {
      evaluation: { generated_at: string };
      artifacts: { evaluation: string; markdown: string };
    };
    const writtenEvaluation = JSON.parse(readFileSync(parsed.artifacts.evaluation, "utf-8")) as {
      generated_at: string;
    };
    expect(parsed.evaluation.generated_at).toBe(writtenEvaluation.generated_at);
    expect(readFileSync(parsed.artifacts.markdown, "utf-8")).toContain(runId);
  });
});
