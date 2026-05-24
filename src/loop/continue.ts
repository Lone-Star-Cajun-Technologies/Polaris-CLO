import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/loader';
import type { ExecutionConfig } from '../config/schema';
import { createAdapter } from './adapters/registry';
import type { BootstrapPacket, DispatchResult } from './adapters/types';

const DEFAULT_STATE_FILE = '.taskchain_artifacts/bootstrap-run/current-state.json';

export interface LoopContinueOptions {
  /** Adapter to use. Overrides polaris.config.json execution.adapter. */
  adapter?: string;
  /** Provider name to dispatch to. Overrides rotation[0]. */
  provider?: string;
  /** Print dispatch command without running it. */
  dryRun?: boolean;
  /** Path to current-state.json. */
  stateFile?: string;
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
}

export interface LoopContinueResult {
  dispatch: DispatchResult;
  activeChild: string;
  provider: string;
}

export async function loopContinue(options: LoopContinueOptions = {}): Promise<LoopContinueResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(cwd);

  const executionConfig = resolveExecutionConfig(config.execution, options.adapter);
  const provider = resolveProvider(executionConfig, options.provider);

  const stateFilePath = path.resolve(cwd, options.stateFile ?? DEFAULT_STATE_FILE);
  const state = readState(stateFilePath);

  const runId = (state.run_id as string) || generateRunId();
  const activeChild = (state.active_child as string) || '';
  const clusterId = (state.cluster_id as string) || '';
  const telemetryFile = path.join(path.dirname(stateFilePath), 'telemetry.jsonl');

  const packet: BootstrapPacket = {
    schema_version: '1.0',
    run_id: runId,
    cluster_id: clusterId,
    active_child: activeChild,
    state_file: stateFilePath,
    telemetry_file: telemetryFile,
  };

  const adapter = createAdapter(executionConfig.adapter, executionConfig);

  if (!options.dryRun) {
    console.log(
      `polaris loop continue: adapter=${executionConfig.adapter} provider=${provider}` +
        (activeChild ? ` child=${activeChild}` : '')
    );
  }

  const result = await adapter.dispatch(packet, { provider, dryRun: options.dryRun });

  if (!options.dryRun) {
    console.log(`\nDispatch complete — exit_code=${result.exit_code} provider=${result.provider_used}`);
    if (result.summary) {
      console.log(`Summary: ${result.summary}`);
    }
  }

  return { dispatch: result, activeChild, provider };
}

function resolveExecutionConfig(
  fromConfig: ExecutionConfig | undefined,
  adapterOverride: string | undefined
): ExecutionConfig {
  if (!fromConfig && !adapterOverride) {
    throw new Error(
      'No execution configuration found. ' +
        'Add an "execution" block to polaris.config.json or pass --adapter on the command line.\n\n' +
        'Example polaris.config.json:\n' +
        JSON.stringify(
          {
            execution: {
              adapter: 'terminal-cli',
              providers: {
                codex: { command: 'codex', args: [] },
                gemini: { command: 'gemini', args: [] },
                custom: { command: '$POLARIS_AGENT' },
              },
              rotation: ['codex', 'gemini'],
              allowCrossAgentFallback: false,
            },
          },
          null,
          2
        )
    );
  }

  if (adapterOverride) {
    return { ...(fromConfig ?? { providers: {} }), adapter: adapterOverride };
  }

  return fromConfig!;
}

function resolveProvider(config: ExecutionConfig, providerOverride: string | undefined): string {
  if (providerOverride) return providerOverride;

  const rotation = config.rotation ?? [];
  if (rotation.length > 0) return rotation[0];

  const providers = Object.keys(config.providers ?? {});
  if (providers.length === 1) return providers[0];

  if (providers.length > 1) {
    throw new Error(
      `Multiple providers configured but no provider selected. ` +
        `Use --provider <name> or set "rotation" in polaris.config.json. ` +
        `Available providers: ${providers.join(', ')}`
    );
  }

  throw new Error(
    `No providers configured. ` +
      `Add providers to polaris.config.json execution.providers or use --provider with a custom command.`
  );
}

function readState(stateFilePath: string): Record<string, unknown> {
  if (!fs.existsSync(stateFilePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Cannot parse state file ${stateFilePath}: ${(err as Error).message}`);
  }
}

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `run-${ts}-${rand}`;
}
