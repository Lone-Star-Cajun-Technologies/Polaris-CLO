export const CURRENT_GRAPH_SCHEMA_VERSION = 1;

export type GraphNodeType = "FILE" | "SYMBOL" | "FUNCTION" | "CLASS" | "METHOD" | "IMPORT";
export type GraphEdgeType = "CALLS" | "IMPORTS" | "DEFINED_IN";
export type GraphSymbolKind = "function" | "class" | "method" | "import" | "unknown";

export interface GraphFile {
  id: string;
  path: string;
  language: string;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  fileId: string;
  name?: string | null;
  startLine?: number | null;
  startColumn?: number | null;
  endLine?: number | null;
  endColumn?: number | null;
}

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  fromNodeId: string;
  toNodeId: string;
  metadata?: string | null;
}

export interface GraphSymbol {
  id: string;
  nodeId: string;
  fileId: string;
  name: string;
  kind: GraphSymbolKind;
  signature?: string | null;
  exported: boolean;
}

