import { Command } from 'commander';
import { loopContinue } from '../loop/continue';

export function createLoopCommand(): Command {
  const loop = new Command('loop');
  loop.description('Loop runtime — dispatch and track child task execution');

  loop.addCommand(buildContinueCommand());
  loop.addCommand(buildStatusCommand());

  return loop;
}

function buildContinueCommand(): Command {
  return new Command('continue')
    .description(
      'Dispatch one child task to an external agent (terminal-cli adapter) and return.\n' +
        'The parent selects the next child on the following invocation.'
    )
    .option(
      '--adapter <name>',
      'Execution adapter (e.g. terminal-cli). Overrides polaris.config.json.',
      undefined
    )
    .option(
      '--provider <name>',
      'Provider to dispatch to: codex | gemini | custom | <any configured name>. ' +
        'Overrides polaris.config.json rotation[0].',
      undefined
    )
    .option(
      '--dry-run',
      'Print the exact command that would be dispatched without running it.',
      false
    )
    .option(
      '--state-file <path>',
      'Path to current-state.json ' +
        '(default: .taskchain_artifacts/bootstrap-run/current-state.json)',
      undefined
    )
    .action(async (opts: {
      adapter?: string;
      provider?: string;
      dryRun: boolean;
      stateFile?: string;
    }) => {
      try {
        const result = await loopContinue({
          adapter: opts.adapter,
          provider: opts.provider,
          dryRun: opts.dryRun,
          stateFile: opts.stateFile,
        });
        if (result.dispatch.exit_code !== 0) {
          process.exitCode = result.dispatch.exit_code;
        }
      } catch (err) {
        console.error(`polaris loop continue: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function buildStatusCommand(): Command {
  return new Command('status')
    .description('Show current loop status and active child (not yet implemented — Cluster 4)')
    .option('--state-file <path>', 'Path to current-state.json')
    .action(() => {
      console.log('polaris loop status — not yet implemented (planned for Cluster 4 / POL-5)');
      process.exit(0);
    });
}
