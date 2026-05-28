
import { Command } from 'commander';
import { resolve } from 'node:path';
import { LocalGraph } from '../tracker/local-graph';
import { TrackerSyncService, TrackerSyncInput } from '../tracker/sync';
import { LinearAdapter } from '../tracker/adapters/linear';
import { McpBridgeAdapter } from '../tracker/adapters/mcp-bridge'; // Import McpBridgeAdapter

export interface TrackerCommandOptions {
  repoRoot: string;
}

export function createTrackerCommand(options: TrackerCommandOptions): Command {
  const trackerCommand = new Command('tracker')
    .description('Manage tracker synchronization and reconciliation');

  trackerCommand
    .command('sync-in [trackerId]')
    .description('Synchronize data from a tracker into the local graph.')
    .option('--adapter <adapterName>', 'Specify the tracker adapter to use (e.g., linear, mcp-bridge)', 'linear')
    .action(async (trackerId: string = 'linear', commandOptions: { dryRun?: boolean; adapter: string }) => {
      console.log(`Executing 'tracker sync-in' for tracker: ${trackerId} using adapter: ${commandOptions.adapter}`);
      
      const mockLocalGraph: LocalGraph = {
        fullGraph: {} as any, 
        getActiveCluster: () => ({} as any),
        getNode: (id: string) => undefined,
        getDependencies: (id: string) => [],
      } as LocalGraph;

      let adapter: LinearAdapter | McpBridgeAdapter;
      switch (commandOptions.adapter) {
        case 'linear':
          adapter = new LinearAdapter();
          break;
        case 'mcp-bridge':
          adapter = new McpBridgeAdapter();
          break;
        default:
          console.error(`Unknown adapter: ${commandOptions.adapter}`);
          process.exit(1);
      }
      
      const service = new TrackerSyncService(adapter, mockLocalGraph);

      const syncInput: TrackerSyncInput = {
        trackerId,
        dryRun: commandOptions.dryRun,
      };
      const report = await service.syncIn(syncInput);
      console.log('Sync-in Report:', report);
    });

  trackerCommand
    .command('reconcile')
    .description('Reconcile local mutations with the remote tracker.')
    .option('--dry-run', 'Perform a dry run without applying changes to the remote tracker.')
    .option('--adapter <adapterName>', 'Specify the tracker adapter to use (e.g., linear, mcp-bridge)', 'linear')
    .action(async (commandOptions: { dryRun?: boolean; adapter: string }) => {
      console.log(`Executing 'tracker reconcile' (dryRun: ${commandOptions.dryRun}) using adapter: ${commandOptions.adapter}`);
      
      const mockLocalGraph: LocalGraph = {
        fullGraph: {} as any,
        getActiveCluster: () => ({} as any),
        getNode: (id: string) => undefined,
        getDependencies: (id: string) => [],
      } as LocalGraph;

      let adapter: LinearAdapter | McpBridgeAdapter;
      switch (commandOptions.adapter) {
        case 'linear':
          adapter = new LinearAdapter();
          break;
        case 'mcp-bridge':
          adapter = new McpBridgeAdapter();
          break;
        default:
          console.error(`Unknown adapter: ${commandOptions.adapter}`);
          process.exit(1);
      }
      
      const service = new TrackerSyncService(adapter, mockLocalGraph);
      
      const report = await service.reconcile(commandOptions.dryRun);
      console.log('Reconciliation Report:', report);
    });

  return trackerCommand;
}
