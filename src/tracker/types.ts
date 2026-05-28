import { z } from "zod";
import { executionGraphV1Schema, executionGraphV2Schema } from "./schema.js";

/**
 * Represents the v2 execution graph.
 * This is the primary data structure for local execution.
 */
export type ExecutionGraphV2 = z.infer<typeof executionGraphV2Schema>;

/**
 * Represents a single node (issue) in the execution graph.
 */
export type ExecutionNode = ExecutionGraphV2["nodes"][string];

/**
 * Represents a single cluster in the execution graph.
 */
export type ExecutionCluster = ExecutionGraphV2["clusters"][string];

/**
 * Represents the v1 `clusters.json` format.
 */
export type ExecutionGraphV1 = z.infer<typeof executionGraphV1Schema>;

/**
 * The in-memory representation of the execution graph, which can be either v1 or v2.
 */
export type ExecutionGraph = ExecutionGraphV2 | ExecutionGraphV1;

/**
 * Type guard to check if an object is a v2 execution graph.
 * @param graph The graph to check.
 * @returns True if the graph is a v2 graph, false otherwise.
 */
export function isV2Graph(graph: ExecutionGraph): graph is ExecutionGraphV2 {
  return "schemaVersion" in graph && graph.schemaVersion === "v2";
}
