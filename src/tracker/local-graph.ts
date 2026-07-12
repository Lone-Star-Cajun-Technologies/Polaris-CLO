import { readFile, writeFile, mkdir } from "node:fs/promises";
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
   * Creates a LocalGraph instance directly from an already-validated v2 graph.
   * Use this when the graph has been built in memory (e.g., by a tracker adapter).
   *
   * @param graph A validated ExecutionGraphV2 object.
   * @returns A new LocalGraph instance.
   */
  static fromGraph(graph: ExecutionGraphV2): LocalGraph {
    return new LocalGraph(graph);
  }
  
  /**
   * Persists the graph to `.polaris/clusters/{clusterId}/clusters.json`.
   * Children are sorted topologically before writing so the saved cluster
   * definition reflects dependency order.
   *
   * @param clusterId The cluster ID to use as the directory name (e.g., "POL-198").
   * @param repoRoot The root directory of the repository.
   * @returns The absolute path of the written file.
   */
  async save(clusterId: string, repoRoot: string = process.cwd()): Promise<string> {
    for (const cluster of Object.values(this.graph.clusters)) {
      if (Array.isArray(cluster.children) && cluster.children.length > 1) {
        cluster.children = this.topoSortChildren(cluster.children);
      }
    }

    const dir = path.join(repoRoot, ".polaris", "clusters", clusterId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "clusters.json");
    await writeFile(filePath, JSON.stringify(this.graph, null, 2), "utf-8");
    return filePath;
  }

  /**
   * Sort a list of children topologically using the graph dependencies.
   * Children with no in-cluster dependencies come first; if a cycle exists,
   * the remaining nodes are appended in their original order.
   */
  private topoSortChildren(children: string[]): string[] {
    const childSet = new Set(children);
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const child of children) {
      inDegree.set(child, 0);
      dependents.set(child, []);
    }

    for (const child of children) {
      for (const dep of this.getDependencies(child)) {
        if (!childSet.has(dep)) continue;
        inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
        dependents.get(dep)!.push(child);
      }
    }

    const queue: string[] = [];
    for (const [child, deg] of inDegree) {
      if (deg === 0) queue.push(child);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      for (const dependent of dependents.get(node) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) queue.push(dependent);
      }
    }

    if (sorted.length < children.length) {
      const sortedSet = new Set(sorted);
      for (const child of children) {
        if (!sortedSet.has(child)) sorted.push(child);
      }
    }

    return sorted;
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
