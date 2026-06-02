import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionConfig, ProviderConfig } from "../../config/schema.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./types.js";
import { buildWorkerInstructions } from "./worker-instructions.js";
import { isWorkerPacket } from "../worker-packet.js";

/** Expand $VAR and ${VAR} references from process.env. */
function expandEnvVars(str: string): string {
  return str
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '')
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? '');
}

/** Substitute {{key}} template variables. Unknown keys are left as-is. */
function substituteTemplates(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{([^}]+)\}\}/g, (original, key) => vars[key.trim()] ?? original);
}

/**
 * Shell-quote a single argument for display purposes only.
 * Not used for actual process spawning (which uses the args array directly).
 */
function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

/** Check whether a command is available on PATH or is an accessible file. */
function resolveCommand(cmd: string): boolean {
  if (path.isAbsolute(cmd)) {
    return fs.existsSync(cmd);
  }
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export class TerminalCliAdapter implements ExecutionAdapter {
  readonly name = 'terminal-cli';

  constructor(private readonly config: ExecutionConfig) {}

  private getProvider(providerName: string): ProviderConfig {
    const providers = this.config.providers ?? {};
    const cfg = providers[providerName];
    if (!cfg) {
      const available = Object.keys(providers);
      const hint =
        available.length > 0
          ? `Available providers: ${available.join(', ')}`
          : 'No providers configured in polaris.config.json execution.providers';
      throw new Error(`Unknown provider "${providerName}". ${hint}`);
    }
    return cfg;
  }

  private buildCommand(
    providerCfg: ProviderConfig,
    packet: BootstrapPacket,
    workerPrompt: string,
    packetFile: string
  ): { command: string; args: string[] } {
    const templateVars: Record<string, string> = {
      active_child: packet.active_child,
      run_id: packet.run_id,
      cluster_id: packet.cluster_id,
      state_file: packet.state_file,
      telemetry_file: packet.telemetry_file,
      model: String(packet.context?.["model"] ?? ""),
      packet_json: JSON.stringify(packet),
      packet_file: packetFile,
      worker_prompt: workerPrompt,
    };

    const rawCommand = providerCfg.command;
    const command = expandEnvVars(substituteTemplates(rawCommand, templateVars));

    // expandEnvVars resolves unset $VAR to '' — detect that case
    if (!command.trim()) {
      throw new Error(
        `Provider command "${rawCommand}" expanded to an empty string — ` +
          `likely an unset environment variable. ` +
          `Set the environment variable or use a literal command name.`
      );
    }

    const args = (providerCfg.args ?? []).map((arg) =>
      expandEnvVars(substituteTemplates(arg, templateVars))
    );

    return { command, args };
  }

  async dispatch(packet: BootstrapPacket, options: DispatchOptions): Promise<DispatchResult> {
    const provider = options.provider || "terminal-cli";
    if (isWorkerPacket(packet) && packet.worker_role === "impl") {
      const allowed = Array.isArray(packet.instructions?.allowed_scope) ? packet.instructions.allowed_scope : [];
      if (allowed.length === 0) {
        const blockedMsg = `Worker blocked: impl packet for ${packet.active_child} has empty allowed_scope. Foreman must provide scope or approve override.`;
        return {
          exit_code: 1,
          provider_used: provider,
          command_run: `terminal-cli:${packet.active_child || "worker"}`,
          summary: JSON.stringify({
            child_id: packet.active_child,
            status: "blocked",
            validation_summary: blockedMsg,
            next_action: "escalate",
            warnings: ["empty-allowed-scope"],
          }),
          stderr: blockedMsg,
        };
      }
    }

    const providerCfg = this.getProvider(provider);
    const workerPrompt = buildWorkerInstructions(packet);

    // Write packet to a named temp file so args can reference it via {{packet_file}}
    const packetFile = path.join(os.tmpdir(), `polaris-packet-${packet.run_id}.json`);
    fs.writeFileSync(packetFile, JSON.stringify(packet, null, 2), 'utf-8');

    try {
      const { command, args } = this.buildCommand(providerCfg, packet, workerPrompt, packetFile);
      const commandLine = formatCommandLine(command, args);

      if (options.dryRun) {
        return this.dryRun(provider, command, args, commandLine, packet, packetFile, workerPrompt);
      }

      if (!resolveCommand(command)) {
        throw new Error(
          `Provider command "${command}" not found on PATH. ` +
            `Install it or update the "command" field for provider "${provider}" ` +
            `in polaris.config.json.`
        );
      }

      return await this.runProcess(command, args, commandLine, packet, packetFile, provider, workerPrompt);
    } finally {
      try {
        fs.unlinkSync(packetFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private dryRun(
    provider: string,
    command: string,
    args: string[],
    commandLine: string,
    packet: BootstrapPacket,
    packetFile: string,
    workerPrompt: string,
  ): DispatchResult {
    const lines = [
      `[dry-run] Provider: ${provider}`,
      `[dry-run] Command:  ${commandLine}`,
      `[dry-run] Stdin:    <bootstrap packet JSON>`,
      `[dry-run] Env vars set:`,
      `            POLARIS_ACTIVE_CHILD=${packet.active_child}`,
      `            POLARIS_RUN_ID=${packet.run_id}`,
      `            POLARIS_CLUSTER_ID=${packet.cluster_id}`,
      `            POLARIS_STATE_FILE=${packet.state_file}`,
      `            POLARIS_TELEMETRY_FILE=${packet.telemetry_file}`,
      `            POLARIS_PACKET_FILE=${packetFile}`,
      `            POLARIS_PACKET_JSON=<json>`,
      `            POLARIS_WORKER_PROMPT=<prompt>`,
      `[dry-run] Worker prompt:`,
      workerPrompt
        .split('\n')
        .map((l) => `            ${l}`)
        .join('\n'),
      `[dry-run] Bootstrap packet:`,
      JSON.stringify(packet, null, 2)
        .split('\n')
        .map((l) => `            ${l}`)
        .join('\n'),
    ];
    console.log(lines.join('\n'));
    return {
      exit_code: 0,
      provider_used: provider,
      command_run: commandLine,
      summary: '[dry-run]',
    };
  }

  private runProcess(
    command: string,
    args: string[],
    commandLine: string,
    packet: BootstrapPacket,
    packetFile: string,
    provider: string,
    workerPrompt: string
  ): Promise<DispatchResult> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        POLARIS_ACTIVE_CHILD: packet.active_child,
        POLARIS_RUN_ID: packet.run_id,
        POLARIS_CLUSTER_ID: packet.cluster_id,
        POLARIS_STATE_FILE: packet.state_file,
        POLARIS_TELEMETRY_FILE: packet.telemetry_file,
        POLARIS_PACKET_FILE: packetFile,
        POLARIS_PACKET_JSON: JSON.stringify(packet),
        POLARIS_WORKER_PROMPT: workerPrompt,
      };

      const child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      // Deliver bootstrap packet to worker via stdin
      child.stdin.write(JSON.stringify(packet), 'utf-8');
      child.stdin.end();

      const stdoutChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk);
        stdoutChunks.push(chunk);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `Provider command "${command}" not found. ` +
                `Ensure it is installed and on PATH.`
            )
          );
        } else {
          reject(err);
        }
      });

      child.on('close', (exitCode: number | null) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        const summary = extractSummary(stdout);
        this.writeSealedResultIfNeeded(packet, summary, stdout, exitCode ?? 1);
        resolve({
          exit_code: exitCode ?? 1,
          provider_used: provider,
          command_run: commandLine,
          stdout,
          summary,
        });
      });
    });
  }

  private writeSealedResultIfNeeded(
    packet: BootstrapPacket,
    summary: string | undefined,
    stdout: string,
    exitCode: number,
  ): void {
    const resultFile = isWorkerPacket(packet) ? packet.result_file_contract?.result_file : undefined;
    if (!resultFile || !summary) {
      return;
    }

    try {
      const parsed = JSON.parse(summary) as Record<string, unknown>;
      const sealedResult = {
        ...parsed,
        run_id: packet.run_id,
        child_id: String(parsed["child_id"] ?? packet.active_child),
        status: exitCode === 0 ? "success" : "failure",
        commit:
          typeof parsed["commit"] === "string"
            ? parsed["commit"]
            : typeof parsed["commit_hash"] === "string"
              ? parsed["commit_hash"]
              : undefined,
        validation: parsed["validation"] ?? parsed["validation_summary"],
        error_message:
          exitCode === 0
            ? undefined
            : typeof parsed["error_message"] === "string"
              ? parsed["error_message"]
              : stdout || summary,
      };
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, JSON.stringify(sealedResult, null, 2), "utf-8");
    } catch {
      // If the provider did not emit parseable compact JSON, leave the result
      // file absent so the parent can surface the sealed-result read failure.
    }
  }
}

/**
 * Extract a worker summary from stdout.
 * Looks for the last line that is valid JSON; falls back to the last 500 chars.
 */
function extractSummary(stdout: string): string | undefined {
  if (!stdout) return undefined;
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // not JSON, keep looking
    }
  }
  // fallback: last 500 characters
  return stdout.length > 500 ? stdout.slice(-500) : stdout;
}
