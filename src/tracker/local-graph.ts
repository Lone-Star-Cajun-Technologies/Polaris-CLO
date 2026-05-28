import { readFile } from "node:fs/promises";
import path from "node:path";
import { executionGraphV1Schema, executionGraphV2Schema } from "./schema.js";
import { isV2Graph, type ExecutionGraph, type ExecutionGraphV2, type ExecutionNode, type ExecutionCluster } from "./types.js";
import { migrateV1toV2 } from "./migration.js";

/**
 * Represents the local execution graph, loaded from a `clusters.json` file.
 * It handles both v1 and v2 formats, migrating v1 to v2 in memory.
 */
export class LocalGraph {
  private graph: ExecutionGraphV2;

  private constructor(graph: ExecutionGraphV2) {
    this.graph = graph;
  }

  /**
   * Loads an execution graph from the specified `clusters.json` file.
   * It automatically detects the schema version and migrates v1 graphs to v2.
   *
   * @param clusterId The ID of the cluster to load (e.g., "POL-105").
   * @param repoRoot The root directory of the repository.
   * @returns A promise that resolves to a new `LocalGraph` instance.
   */
  static async load(clusterId: string, repoRoot: string = process.cwd()): Promise<LocalGraph> {
    const filePath = path.join(repoRoot, ".polaris", "clusters", clusterId, "clusters.json");
    const fileContent = await readFile(filePath, "utf-8");
    const rawGraph = JSON.parse(fileContent) as ExecutionGraph;

    let v2Graph: ExecutionGraphV2;

    if (isV2Graph(rawGraph)) {
      v2Graph = executionGraphV2Schema.parse(rawGraph);
    } else {
      const v1Graph = executionGraphV1Schema.parse(rawGraph);
      v2Graph = migrateV1toV2(v1Graph);
      // We can also validate the migrated graph to be safe
      v2Graph = executionGraphV2Schema.parse(v2Graph);
    }

    return new LocalGraph(v2Graph);
  }
  
  /**
   * Returns the full v2 execution graph.
   */
  get fullGraph(): ExecutionGraphV2 {
    return this.graph;
  }

  /**
   * Returns the active cluster.
   */
  getActiveCluster(): ExecutionCluster {
    return this.graph.clusters[this.graph.activeCluster];
  }

  /**
   * Returns a node by its ID.
   * @param id The ID of the node to retrieve.
   */
  getNode(id: string): ExecutionNode | undefined {
    return this.graph.nodes[id];
  }

  /**
   * Returns the dependencies for a given node.
   * @param id The ID of the node to get dependencies for.
   * @returns An array of node IDs that the given node is blocked by.
   */
  getDependencies(id: string): string[] {
    return this.graph.dependencies[id] ?? [];
  }
}
