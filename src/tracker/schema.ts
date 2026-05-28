import { z } from "zod";

/**
 * The full v2 execution graph schema.
 * Use this for validation when loading a graph from disk.
 */
export const executionGraphV2Schema = z.object({
  schemaVersion: z.literal("v2"),

  /** Source of truth metadata for the execution cluster. */
  source: z.object({
    id: z.string(),
    type: z.string(),
    analysis: z
      .object({
        id: z.string(),
        doc: z.string().nullable().optional(),
      })
      .optional(),
  }),

  /** Normalized map of all nodes (issues) in the graph. */
  nodes: z.record(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      sessionType: z.string().optional(),
    })
  ),

  /** Dependency map. Key is the node ID, value is an array of node IDs it is blocked by. */
  dependencies: z.record(z.array(z.string())),

  /**
   * Clusters are ordered groups of nodes.
   * This is the primary execution structure.
   */
  clusters: z.record(
    z.object({
      id: z.string(),
      title: z.string(),
      children: z.array(z.string()),
    })
  ),

  /** The active cluster ID to be used for execution. */
  activeCluster: z.string(),
}).superRefine((data, ctx) => {
  if (data.activeCluster && !data.clusters[data.activeCluster]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeCluster"],
      message: `activeCluster '${data.activeCluster}' does not exist in the clusters map`,
    });
  }
});

/**
 * The v1 `clusters.json` schema.
 * This is used for migration purposes.
 */
export const executionGraphV1Schema = z.object({
  source_id: z.string(),
  analyze_source_id: z.string().optional(),
  source_type: z.string(),
  created_at: z.string(),
  analysis_doc: z.string().nullable().optional(),
  clusters: z.array(
    z.object({
      cluster_id: z.string(),
      description: z.string(),
      children: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          session_type: z.string(),
          blockedBy: z.array(z.string()),
        })
      ),
    })
  ),
});
