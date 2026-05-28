import type { ExecutionGraphV1, ExecutionGraphV2 } from "./types.js";

/**
 * Migrates a v1 execution graph to a v2 execution graph.
 *
 * @param v1Graph The v1 execution graph to migrate.
 * @returns The migrated v2 execution graph.
 */
export function migrateV1toV2(v1Graph: ExecutionGraphV1): ExecutionGraphV2 {
  if (!v1Graph.clusters || v1Graph.clusters.length === 0) {
    throw new Error("Cannot migrate v1 execution graph: clusters array is empty or missing.");
  }

  const v2Graph: ExecutionGraphV2 = {
    schemaVersion: "v2",
    source: {
      id: v1Graph.source_id,
      type: v1Graph.source_type,
    },
    nodes: {},
    dependencies: {},
    clusters: {},
    activeCluster: v1Graph.clusters[0]?.cluster_id ?? "default-cluster",
  };

  if (v1Graph.analyze_source_id) {
    v2Graph.source.analysis = {
      id: v1Graph.analyze_source_id,
      doc: v1Graph.analysis_doc,
    };
  }

  for (const v1Cluster of v1Graph.clusters) {
    const childNodeIds: string[] = [];
    for (const child of v1Cluster.children) {
      childNodeIds.push(child.id);

      // Add node to the normalized map
      if (!v2Graph.nodes[child.id]) {
        v2Graph.nodes[child.id] = {
          id: child.id,
          title: child.title,
          status: "Todo", // V1 doesn't have status, so default to Todo
          sessionType: child.session_type,
        };
      }

      // Add dependencies
      if (child.blockedBy.length > 0) {
        v2Graph.dependencies[child.id] = child.blockedBy;
      }
    }
    
    v2Graph.clusters[v1Cluster.cluster_id] = {
        id: v1Cluster.cluster_id,
        title: v1Cluster.description,
        children: childNodeIds,
    }
  }

  return v2Graph;
}
