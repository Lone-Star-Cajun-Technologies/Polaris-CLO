import type { GraphSymbolKind } from "../store/types.js";

export const GRAPH_QUERY_RESPONSE_VERSION = 1 as const;
export const DEFAULT_IMPACT_MAX_DEPTH = 8;

export interface GraphSymbol {
  version: typeof GRAPH_QUERY_RESPONSE_VERSION;
  id: string;
  name: string;
  kind: GraphSymbolKind;
  signature: string | null;
  exported: boolean;
  filePath: string;
}

export interface GraphFile {
  version: typeof GRAPH_QUERY_RESPONSE_VERSION;
  path: string;
  language: string;
}

export interface GraphStats {
  version: typeof GRAPH_QUERY_RESPONSE_VERSION;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  symbolCount: number;
}
