import { LocalGraph } from "./local-graph.js";
import { LinearAdapter } from "./adapters/linear/index.js";

/**
 * Loads the execution graph from the configured tracker.
 *
 * @param config The Polaris configuration.
 * @param clusterId The ID of the cluster to load.
 * @returns A promise that resolves to a graph instance, or null if no tracker is enabled.
 */
export async function loadTrackerGraph(
  config: PolarisConfig,
  clusterId: string,
): Promise<LocalGraph | null> {
  if (config.tracker?.["local-file"]?.enabled) {
    return LocalGraph.load(clusterId);
  }

  if (config.tracker?.linear?.enabled) {
    const linearAdapter = new LinearAdapter(config);
    return linearAdapter.syncIn();
  }

  return null;
}

