import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionConfig, ProviderConfig } from "../../config/schema.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./types.js";
import { buildWorkerInstructions } from "./worker-instructions.js";
import { isWorkerPacket } from "../worker-packet.js";
import { validateCompactReturn } from "../compact-return.js";

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

function isQuotaExhaustedSignal(...parts: Array<string | undefined>): boolean {
  const text = parts.filter((value): value is string => typeof value === "string" && value.length > 0).join("\n").toLowerCase();
  if (!text) return false;
  return (
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("resource exhausted") ||
    text.includes("insufficient_quota")
  );
}

function hasWorkerExecutionEvidence(
  packet: BootstrapPacket,
  resultFilePath: string | undefined,
): boolean {
  if (resultFilePath && fs.existsSync(resultFilePath)) return true;
  if (!packet.telemetry_file || !packet.active_child || !fs.existsSync(packet.telemetry_file)) return false;
  try {
    const telemetry = fs.readFileSync(packet.telemetry_file, "utf-8").trim();
    if (!telemetry) return false;
    const lines = telemetry.split("\n");
    const packetDispatchId = packet.dispatch_id;
    // Scan backwards: when both the packet and the parsed event carry a dispatch_id,
    // use that as the primary scope gate so stale events from a previous attempt are
    // never attributed to the current dispatch.  Fall back to the child-dispatched
    // boundary for older telemetry that lacks dispatch_id on individual events.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { event?: string; child_id?: string; dispatch_id?: string };
        if (parsed.child_id !== packet.active_child) continue;

        if (
          parsed.event === "worker-acknowledged" ||
          parsed.event === "worker-heartbeat" ||
          parsed.event === "worker-result"
        ) {
          const eventDispatchId = parsed.dispatch_id;
          if (packetDispatchId && eventDispatchId) {
            // Primary gate: dispatch_id available on both sides — match determines
            // whether this event belongs to the current dispatch.
            if (eventDispatchId === packetDispatchId) return true;
            // Mismatch — event belongs to a different dispatch; keep scanning.
            continue;
          }
          // Fallback: dispatch_id not available on one or both sides — accept the
          // event as evidence for the current dispatch (scoped by the
          // child-dispatched boundary below).
          return true;
        }

        // Boundary fallback: stop at the child-dispatched event so events from a
        // prior attempt are not counted when dispatch_id matching is unavailable.
        if (parsed.event === "child-dispatched") break;
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
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

  async probe(providerName: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const providerCfg = this.getProvider(providerName);
      const expandedCommand = expandEnvVars(providerCfg.command);
      if (!resolveCommand(expandedCommand.split(' ')[0] ?? expandedCommand)) {
        return { ok: false, error: `Provider command "${providerCfg.command}" not found on PATH` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async dispatch(packet: BootstrapPacket, options: DispatchOptions): Promise<DispatchResult> {
    const primaryProvider = options.provider || "terminal-cli";
    const routerEvidence = options.routerDecision;
    const providerAttempts: NonNullable<DispatchResult["provider_attempts"]> = [];
    if (
      isWorkerPacket(packet) &&
      (packet.worker_role === "impl" || packet.worker_role === "repair")
    ) {
      const allowed = Array.isArray(packet.instructions?.allowed_scope) ? packet.instructions.allowed_scope : [];
      if (allowed.length === 0) {
        const blockedMsg = `Worker blocked: ${packet.worker_role} packet for ${packet.active_child} has empty allowed_scope. Foreman must provide scope or approve override.`;
        return {
          exit_code: 1,
          provider_used: primaryProvider,
          command_run: `terminal-cli:${packet.active_child || "worker"}`,
          summary: JSON.stringify({
            child_id: packet.active_child,
            status: "blocked",
            validation_summary: blockedMsg,
            next_action: "escalate",
            warnings: ["empty-allowed-scope"],
          }),
          stderr: blockedMsg,
          pre_dispatch_failure: true,
          failure_origin: "provider-launch",
          failure_category: "launch-error",
          fallback_eligible: false,
          router_evidence: routerEvidence,
          provider_attempts: [
            {
              provider: primaryProvider,
              failure_origin: "provider-launch",
              failure_category: "launch-error",
              pre_dispatch_failure: true,
              fallback_eligible: false,
              message: blockedMsg,
            },
          ],
        };
      }
    }

    // Validate primary provider eagerly — throws for unknown/misconfigured primary,
    // preserving the pre-refactor contract for callers specifying invalid providers.
    const primaryCfg = this.getProvider(primaryProvider);

    // Build fallback chain from policy. Only append providers that are configured.
    // Fallback is suppressed when providerPolicy.worker.noFallback is true.
    const workerPolicy = this.config.providerPolicy?.['worker'];
    const canFallback = !(workerPolicy?.noFallback === true);
    const policyProviders: string[] = (canFallback && Array.isArray(workerPolicy?.providers))
      ? workerPolicy.providers
      : [];
    const routerProviders: string[] =
      canFallback && Array.isArray(routerEvidence?.providersTried)
        ? routerEvidence.providersTried
        : [];
    const fallbackOrder = routerProviders.length > 0 ? routerProviders : policyProviders;
    const providersToTry: Array<{ name: string; cfg: ProviderConfig; isPrimary: boolean }> = [
      { name: primaryProvider, cfg: primaryCfg, isPrimary: true },
    ];
    if (canFallback) {
      for (const p of fallbackOrder) {
        if (p !== primaryProvider && p in (this.config.providers ?? {})) {
          try {
            providersToTry.push({ name: p, cfg: this.getProvider(p), isPrimary: false });
          } catch {
            // fallback provider not found — skip silently
          }
        }
      }
    }

    const workerPrompt = buildWorkerInstructions(packet);
    // Write packet to a named temp file so args can reference it via {{packet_file}}
    const packetFile = path.join(os.tmpdir(), `polaris-packet-${packet.run_id}.json`);
    fs.writeFileSync(packetFile, JSON.stringify(packet, null, 2), 'utf-8');

    let lastResult: DispatchResult | undefined;

    try {
      for (const { name: provider, cfg: providerCfg, isPrimary } of providersToTry) {
        let command: string;
        let args: string[];
        try {
          ({ command, args } = this.buildCommand(providerCfg, packet, workerPrompt, packetFile));
        } catch (err) {
          if (isPrimary) throw err; // primary build failures must propagate
          lastResult = {
            exit_code: 1,
            provider_used: provider,
            command_run: provider,
            stderr: err instanceof Error ? err.message : String(err),
            pre_dispatch_failure: true,
            failure_origin: "provider-launch",
            failure_category: "launch-error",
            fallback_eligible: true,
            router_evidence: routerEvidence,
          };
          providerAttempts.push({
            provider,
            failure_origin: "provider-launch",
            failure_category: "launch-error",
            pre_dispatch_failure: true,
            fallback_eligible: true,
            message: lastResult.stderr,
          });
          continue;
        }

        const commandLine = formatCommandLine(command, args);

        if (options.dryRun) {
          const dryRun = this.dryRun(provider, command, args, commandLine, packet, packetFile, workerPrompt);
          return {
            ...dryRun,
            router_evidence: routerEvidence,
            provider_attempts: providerAttempts,
          };
        }

        if (!resolveCommand(command)) {
          lastResult = {
            exit_code: 1,
            provider_used: provider,
            command_run: commandLine,
            stderr: `Provider command "${command}" not found on PATH. ` +
              `Install it or update the "command" field for provider "${provider}" in polaris.config.json.`,
            pre_dispatch_failure: true,
            failure_origin: "provider-launch",
            failure_category: "provider-unavailable",
            fallback_eligible: true,
            router_evidence: routerEvidence,
          };
          providerAttempts.push({
            provider,
            failure_origin: "provider-launch",
            failure_category: "provider-unavailable",
            pre_dispatch_failure: true,
            fallback_eligible: true,
            message: lastResult.stderr,
          });
          continue;
        }

        let result: DispatchResult;
        try {
          result = await this.runProcess(command, args, commandLine, packet, packetFile, provider, workerPrompt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          lastResult = {
            exit_code: 1,
            provider_used: provider,
            command_run: commandLine,
            stderr: message,
            pre_dispatch_failure: true,
            failure_origin: "provider-launch",
            failure_category: "provider-unavailable",
            fallback_eligible: true,
            router_evidence: routerEvidence,
          };
          providerAttempts.push({
            provider,
            failure_origin: "provider-launch",
            failure_category: "provider-unavailable",
            pre_dispatch_failure: true,
            fallback_eligible: true,
            message,
          });
          continue;
        }

        // Worker succeeded — return immediately.
        if (result.exit_code === 0) {
          return {
            ...result,
            router_evidence: routerEvidence,
            provider_attempts: providerAttempts,
          };
        }

        const resultFilePath = isWorkerPacket(packet) ? packet.result_file_contract?.result_file : undefined;
        const workerStarted = hasWorkerExecutionEvidence(packet, resultFilePath);
        if (workerStarted) {
          return {
            ...result,
            failure_origin: "worker-execution",
            failure_category: "worker-failure",
            fallback_eligible: false,
            router_evidence: routerEvidence,
            provider_attempts: providerAttempts,
          };
        }

        const category = isQuotaExhaustedSignal(result.stderr, result.stdout, result.summary)
          ? "quota-exhausted"
          : "provider-unavailable";
        const classified: DispatchResult = {
          ...result,
          pre_dispatch_failure: true,
          failure_origin: "provider-launch",
          failure_category: category,
          fallback_eligible: true,
          router_evidence: routerEvidence,
        };
        providerAttempts.push({
          provider,
          failure_origin: "provider-launch",
          failure_category: category,
          pre_dispatch_failure: true,
          fallback_eligible: true,
          message: result.stderr ?? result.summary,
        });
        lastResult = classified;
      }

      const exhausted = lastResult ?? {
        exit_code: 1,
        provider_used: primaryProvider,
        command_run: '',
        stderr: 'All configured providers exhausted without starting a worker',
        pre_dispatch_failure: true,
        failure_origin: "provider-launch",
        failure_category: "provider-unavailable",
        fallback_eligible: false,
        router_evidence: routerEvidence,
        provider_attempts: providerAttempts,
      };
      return {
        ...exhausted,
        // All providers have been exhausted — no further fallback is possible.
        fallback_eligible: false,
        router_evidence: exhausted.router_evidence ?? routerEvidence,
        provider_attempts: exhausted.provider_attempts ?? providerAttempts,
      };
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
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Deliver bootstrap packet to worker via stdin
      child.stdin.write(JSON.stringify(packet), 'utf-8');
      child.stdin.end();

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
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
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        const summary = extractSummary(stdout);
        this.writeSealedResultIfNeeded(packet, summary, stdout, exitCode ?? 1);
        resolve({
          exit_code: exitCode ?? 1,
          provider_used: provider,
          command_run: commandLine,
          stdout,
          summary,
          stderr: stderr || undefined,
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
      // Normalize legacy CompactReturn shapes before validation so that
      // workers using pre-spec formats (status:"success", validation:{passed:[...]})
      // are accepted rather than silently marked as failures.
      const normalized = normalizeLegacyCompactReturn(parsed);
      const compactReturnErrors = validateCompactReturn(normalized);
      const isValidCompactReturn = compactReturnErrors.length === 0;

      // If the parsed result isn't a valid CompactReturn, treat it as a failure
      // regardless of exit code — this prevents phantom successes from workers
      // that return minimal status objects instead of proper CompactReturn structs.
      const effectiveStatus = (exitCode === 0 && isValidCompactReturn) ? "success" : "failure";

      const sealedResult = {
        run_id: packet.run_id,
        child_id: String(normalized["child_id"] ?? packet.active_child),
        status: effectiveStatus,
        commit:
          typeof normalized["commit"] === "string"
            ? normalized["commit"]
            : typeof normalized["commit_hash"] === "string"
              ? normalized["commit_hash"]
              : undefined,
        validation: normalized["validation"] ?? normalized["validation_summary"],
        error_message:
          effectiveStatus === "failure"
            ? (!isValidCompactReturn
                ? `CompactReturn validation failed: ${compactReturnErrors.join("; ")}`
                : typeof normalized["error_message"] === "string"
                  ? normalized["error_message"]
                  : stdout || summary)
            : undefined,
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
 * Normalize a legacy CompactReturn shape to the current spec before validation.
 * Handles pre-spec formats produced by older workers:
 *   - status:"success"|"completed" → status:"done"
 *   - validation:{passed:[...],failed:[...]} → validation:"passed"|"failed"|"skipped"
 *   - missing boolean flags → false
 */
function normalizeLegacyCompactReturn(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };

  if (result['status'] === 'success' || result['status'] === 'completed') {
    result['status'] = 'done';
  }

  if (typeof result['validation'] === 'object' && result['validation'] !== null) {
    const v = result['validation'] as Record<string, unknown>;
    if (Array.isArray(v['failed']) && (v['failed'] as unknown[]).length > 0) {
      result['validation'] = 'failed';
    } else if (Array.isArray(v['passed']) && (v['passed'] as unknown[]).length > 0) {
      result['validation'] = 'passed';
    } else {
      result['validation'] = 'skipped';
    }
  }

  for (const flag of ['tracker_updated', 'state_updated', 'telemetry_updated'] as const) {
    if (typeof result[flag] !== 'boolean') {
      result[flag] = false;
    }
  }

  return result;
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
