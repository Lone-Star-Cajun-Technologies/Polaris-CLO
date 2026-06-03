import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { readBootstrapPacket } from "../loop/worker.js";
import { getWorkerCommitPolicy, isWorkerPacket } from "../loop/worker-packet.js";
import { validateWorkerCommitScope } from "../loop/git-custody.js";
import { readState, writeStateAtomic, type LoopState } from "../loop/checkpoint.js";
import type { SealedWorkerResult } from "../loop/worker-packet.js";

export interface WorkerCommandOptions {
  repoRoot: string;
}

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, `${JSON.stringify(event)}\n`, "utf-8");
}

function failWithHelp(command: Command, commandName: string): never {
  const subcommand = command.args[0];
  const message = subcommand
    ? `error: unknown command '${subcommand}' for '${commandName}'. Run '${commandName} --help'.`
    : `error: missing command for '${commandName}'. Run '${commandName} --help'.`;
  command.error(message, {
    code: "commander.missingCommand",
    exitCode: 1,
  });
}

function readActiveWorkerPacket() {
  const packet = readBootstrapPacket(process.argv);
  if (!isWorkerPacket(packet)) {
    throw new Error("Active worker packet is missing or invalid");
  }
  return packet;
}

function getCommitHash(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
}

function resolveRepoPath(repoRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function validateWorkerCompletionResult(
  repoRoot: string,
  packet: ReturnType<typeof readActiveWorkerPacket>,
  resultFile: string,
): { ok: true; result: Omit<SealedWorkerResult, "status"> & { commit: string; status: "success" | "done" } } | { ok: false; reason: string } {
  if (!resultFile) {
    return { ok: false, reason: "missing result file path" };
  }

  if (!packet.active_child) {
    return { ok: false, reason: "active worker packet has no active_child" };
  }

  const resolvedResultFile = resolveRepoPath(repoRoot, resultFile);

  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(readFileSync(resolvedResultFile, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: "sealed result is not a JSON object" };
    }
    parsed = raw as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      reason: `failed to read sealed result (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const runId = String(parsed["run_id"] ?? "").trim();
  if (runId !== packet.run_id) {
    return { ok: false, reason: `sealed result run_id "${runId || "missing"}" does not match active packet` };
  }

  const childId = String(parsed["child_id"] ?? "").trim();
  if (childId !== packet.active_child) {
    return { ok: false, reason: `sealed result child_id "${childId || "missing"}" does not match active child "${packet.active_child}"` };
  }

  const status = String(parsed["status"] ?? "").trim().toLowerCase();
  if (!["success", "done"].includes(status)) {
    return { ok: false, reason: `sealed result status is "${status || "missing"}" (expected success)` };
  }

  const commit = String(parsed["commit"] ?? parsed["commit_hash"] ?? parsed["commit_sha"] ?? "").trim();
  if (!commit) {
    return { ok: false, reason: "sealed result is missing commit evidence" };
  }

  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    return { ok: false, reason: `sealed result commit "${commit}" is not a valid git hash` };
  }

  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    return { ok: false, reason: `sealed result commit "${commit}" could not be verified in git` };
  }

  return {
    ok: true,
    result: {
      ...(parsed as SealedWorkerResult),
      run_id: packet.run_id,
      child_id: packet.active_child,
      status: status === "done" ? "done" : "success",
      commit,
    },
  };
}

function updateCompletionState(
  state: LoopState,
  childId: string,
  commit: string,
) {
  const completedChildren = Array.from(new Set([...state.completed_children, childId]));
  const remainingOpenChildren = state.open_children.filter((child) => child !== childId);
  const completedChildrenResults = {
    ...(state.completed_children_results ?? {}),
    [childId]: {
      status: "done" as const,
      validation: "passed" as const,
      commit,
      next_recommended_action: "continue" as const,
    },
  };

  return {
    ...state,
    active_child: "",
    open_children: remainingOpenChildren,
    completed_children: completedChildren,
    completed_children_results: completedChildrenResults,
    next_open_child: remainingOpenChildren[0] ?? null,
    step_cursor: "checkpoint",
    status: remainingOpenChildren.length > 0 ? "running" : "cluster-complete",
    last_commit: commit,
    context_budget: {
      ...state.context_budget,
      children_completed: completedChildren.length,
    },
    updated_at: new Date().toISOString(),
  };
}

function emitWorkerCompletionTelemetry(
  telemetryFile: string,
  event: Record<string, unknown>,
): void {
  try {
    appendTelemetry(telemetryFile, event);
  } catch (error) {
    process.stderr.write(
      `[polaris-worker] telemetry write failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function createWorkerCommand(options: WorkerCommandOptions): Command {
  const worker = new Command("worker")
    .description("mutating: worker-owned commit operations")
    .showHelpAfterError()
    .showSuggestionAfterError();

  worker.action(() => failWithHelp(worker, "polaris worker"));

  worker
    .command("commit")
    .description("mutating: validate the staged git index against the active worker packet and create one commit")
    .action(() => {
      try {
        const packet = readActiveWorkerPacket();
        const { allowedScope, prohibitedWritePaths } = getWorkerCommitPolicy(packet);
        const validation = validateWorkerCommitScope(
          options.repoRoot,
          allowedScope,
          prohibitedWritePaths,
        );

        if (validation.staged_files.length === 0) {
          appendTelemetry(packet.telemetry_file, {
            event: "worker-commit-rejected",
            event_id: randomUUID(),
            run_id: packet.run_id,
            child_id: packet.active_child,
            reason: "no-staged-files",
            allowed_scope: allowedScope,
            prohibited_write_paths: prohibitedWritePaths,
            staged_files: [],
            violations: [],
            timestamp: new Date().toISOString(),
          });
          process.stderr.write("worker commit rejected: no staged files\n");
          process.exit(1);
        }

        if (validation.violations.length > 0) {
          appendTelemetry(packet.telemetry_file, {
            event: "worker-commit-rejected",
            event_id: randomUUID(),
            run_id: packet.run_id,
            child_id: packet.active_child,
            reason: "scope-violation",
            allowed_scope: allowedScope,
            prohibited_write_paths: prohibitedWritePaths,
            staged_files: validation.staged_files,
            violations: validation.violations,
            timestamp: new Date().toISOString(),
          });

          const summary = validation.violations
            .map((violation) => `${violation.kind}:${violation.path}`)
            .join(", ");
          process.stderr.write(`worker commit rejected: ${summary}\n`);
          process.exit(1);
        }

        execFileSync(
          "git",
          ["commit", "-m", `polaris worker commit: ${packet.active_child || packet.run_id}`],
          {
            cwd: options.repoRoot,
            stdio: "ignore",
          },
        );
        process.stdout.write(`${getCommitHash(options.repoRoot)}\n`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("process.exit(")) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`worker commit failed: ${message}\n`);
        process.exit(1);
      }
    });

  worker
    .command("complete")
    .description("mutating: validate a sealed worker result and update current-state.json")
    .argument("<result-file>", "Path to the sealed worker result JSON")
    .action((resultFile: string) => {
      let packet;
      try {
        packet = readActiveWorkerPacket();
      } catch (error) {
        process.stderr.write(
          `worker complete failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
        return;
      }

      try {
        const stateFile = resolveRepoPath(options.repoRoot, packet.state_file);
        const telemetryFile = resolveRepoPath(options.repoRoot, packet.telemetry_file);
        const validation = validateWorkerCompletionResult(options.repoRoot, packet, resultFile);
        if (!validation.ok) {
          emitWorkerCompletionTelemetry(telemetryFile, {
            event: "worker-complete-failed",
            event_id: randomUUID(),
            run_id: packet.run_id,
            child_id: packet.active_child,
            result_file: resolveRepoPath(options.repoRoot, resultFile),
            reason: validation.reason,
            timestamp: new Date().toISOString(),
          });
          process.stderr.write(`worker complete rejected: ${validation.reason}\n`);
          process.exit(1);
          return;
        }

        const state = readState(stateFile);
        const updatedState = updateCompletionState(state, packet.active_child, validation.result.commit);
        writeStateAtomic(stateFile, updatedState);

        emitWorkerCompletionTelemetry(telemetryFile, {
          event: "worker-complete",
          event_id: randomUUID(),
          run_id: packet.run_id,
          child_id: packet.active_child,
          result_file: resolveRepoPath(options.repoRoot, resultFile),
          status: validation.result.status,
          commit: validation.result.commit,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const telemetryFile = resolveRepoPath(options.repoRoot, packet.telemetry_file);
        emitWorkerCompletionTelemetry(telemetryFile, {
          event: "worker-complete-failed",
          event_id: randomUUID(),
          run_id: packet.run_id,
          child_id: packet.active_child,
          result_file: resolveRepoPath(options.repoRoot, resultFile),
          reason: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
        process.stderr.write(`worker complete failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });

  return worker;
}
