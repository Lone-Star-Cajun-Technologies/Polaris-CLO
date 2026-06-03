import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { readBootstrapPacket } from "../loop/worker.js";
import { getWorkerCommitPolicy, isWorkerPacket } from "../loop/worker-packet.js";
import { validateWorkerCommitScope } from "../loop/git-custody.js";

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

  return worker;
}
