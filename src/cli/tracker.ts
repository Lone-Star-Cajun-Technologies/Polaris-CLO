
import { Command } from 'commander';
import { resolve } from 'node:path';
import { LocalGraph } from '../tracker/local-graph.js';
import { TrackerSyncService } from '../tracker/sync/index.js';
import { LinearAdapter } from '../tracker/adapters/linear/index.js';
import { loadConfig } from '../config/loader.js';

export interface TrackerCommandOptions {
  repoRoot: string;
}

export function createTrackerCommand(options: TrackerCommandOptions): Command {
  const trackerCommand = new Command('tracker')
    .description('Manage tracker synchronization and reconciliation');

  trackerCommand
    .command('sync-in [trackerId]')
    .description('Synchronize data from a tracker into the local graph.')
    .option('--adapter <adapterName>', 'Specify the tracker adapter to use (e.g., linear, mcp-bridge)')
    .option('-r, --repo-root <path>', 'Repository root', options.repoRoot)
    .action(async (trackerId: string | undefined, commandOptions: { adapter?: string; repoRoot: string }) => {
      const repoRoot = resolve(commandOptions.repoRoot ?? options.repoRoot);
      const config = loadConfig(repoRoot);
      const adapterName = commandOptions.adapter ?? config.tracker?.adapter ?? 'linear';

      if (!trackerId) {
        console.error("Error: trackerId is required (e.g., 'polaris tracker sync-in POL-198').");
        process.exit(1);
      }

      console.log(`Executing 'tracker sync-in' for tracker: ${trackerId} using adapter: ${adapterName}`);

      if (adapterName === 'linear') {
        // LinearAdapter is a pull-only sync-in adapter — use it directly
        const adapter = new LinearAdapter(config);
        let graph: LocalGraph;
        try {
          graph = await adapter.syncIn(trackerId);
        } catch (err) {
          console.error(`sync-in failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        console.log(`sync-in complete. Active cluster: ${graph.fullGraph.activeCluster}`);
        return;
      }

      if (adapterName === 'mcp-bridge') {
        let localGraph: LocalGraph;
        try {
          localGraph = await LocalGraph.load(trackerId, repoRoot);
        } catch (err) {
          console.error(`Failed to load local graph for cluster '${trackerId}': ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        const { McpBridgeAdapter } = await import('../tracker/adapters/mcp-bridge.js');
        const adapter = new McpBridgeAdapter();
        const service = new TrackerSyncService(adapter, localGraph);
        await service.ready;

        const report = await service.syncIn({ trackerId });
        console.log('Sync-in Report:', report);
        return;
      }

      console.error(`Unknown adapter: ${adapterName}`);
      process.exit(1);
    });

  trackerCommand
    .command('reconcile <trackerId>')
    .description('Reconcile local mutations with the remote tracker.')
    .option('--dry-run', 'Perform a dry run without applying changes to the remote tracker.')
    .option('--adapter <adapterName>', 'Specify the tracker adapter to use (e.g., mcp-bridge)')
    .option('-r, --repo-root <path>', 'Repository root', options.repoRoot)
    .action(async (trackerId: string, commandOptions: { dryRun?: boolean; adapter?: string; repoRoot: string }) => {
      const repoRoot = resolve(commandOptions.repoRoot ?? options.repoRoot);
      const config = loadConfig(repoRoot);
      const adapterName = commandOptions.adapter ?? config.tracker?.adapter ?? 'mcp-bridge';

      if (adapterName === 'linear') {
        console.error("The 'linear' adapter is sync-in only and does not support reconciliation. Use 'mcp-bridge' for reconciliation.");
        process.exit(1);
      } else if (adapterName !== 'mcp-bridge') {
        console.error(`Unknown adapter: ${adapterName}`);
        process.exit(1);
      }

      console.log(`Executing 'tracker reconcile' for cluster '${trackerId}' (dryRun: ${commandOptions.dryRun}) using adapter: ${adapterName}`);

      let localGraph: LocalGraph;
      try {
        localGraph = await LocalGraph.load(trackerId, repoRoot);
      } catch (err) {
        console.error(`Failed to load local graph for cluster '${trackerId}': ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      const { McpBridgeAdapter } = await import('../tracker/adapters/mcp-bridge.js');
      const adapter = new McpBridgeAdapter();
      const service = new TrackerSyncService(adapter, localGraph);
      await service.ready;

      const report = await service.reconcile(commandOptions.dryRun);
      console.log('Reconciliation Report:', report);
    });

  return trackerCommand;
}
