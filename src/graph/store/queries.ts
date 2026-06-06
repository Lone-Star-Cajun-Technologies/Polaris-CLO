import type { DatabaseSync } from "node:sqlite";
import type { GraphEdge, GraphFile, GraphNode, GraphSymbol } from "./types.js";

interface GraphFileRow {
  id: string;
  path: string;
  language: string;
}

interface GraphSymbolRow {
  id: string;
  nodeId: string;
  fileId: string;
  name: string;
  kind: GraphSymbol["kind"];
  signature: string | null;
  exported: number;
}

export function insertNode(db: DatabaseSync, node: GraphNode): void {
  db.prepare(
    `
      INSERT INTO nodes (
        id,
        type,
        file_id,
        name,
        start_line,
        start_column,
        end_line,
        end_column
      ) VALUES (
        @id,
        @type,
        @fileId,
        @name,
        @startLine,
        @startColumn,
        @endLine,
        @endColumn
      )
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        file_id = excluded.file_id,
        name = excluded.name,
        start_line = excluded.start_line,
        start_column = excluded.start_column,
        end_line = excluded.end_line,
        end_column = excluded.end_column
    `,
  ).run({
    id: node.id,
    type: node.type,
    fileId: node.fileId,
    name: node.name ?? null,
    startLine: node.startLine ?? null,
    startColumn: node.startColumn ?? null,
    endLine: node.endLine ?? null,
    endColumn: node.endColumn ?? null,
  });
}

export function insertEdge(db: DatabaseSync, edge: GraphEdge): void {
  db.prepare(
    `
      INSERT INTO edges (
        id,
        type,
        from_node_id,
        to_node_id,
        metadata
      ) VALUES (
        @id,
        @type,
        @fromNodeId,
        @toNodeId,
        @metadata
      )
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        from_node_id = excluded.from_node_id,
        to_node_id = excluded.to_node_id,
        metadata = excluded.metadata
    `,
  ).run({
    id: edge.id,
    type: edge.type,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    metadata: edge.metadata ?? null,
  });
}

export function lookupSymbol(db: DatabaseSync, name: string, filePath?: string): GraphSymbol | null {
  const row = db
    .prepare(
      `
        SELECT
          s.id,
          s.node_id AS nodeId,
          s.file_id AS fileId,
          s.name,
          s.kind,
          s.signature,
          s.exported
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.name = ?1
          AND (?2 IS NULL OR f.path = ?2)
        ORDER BY s.id
        LIMIT 1
      `,
    )
    .get(name, filePath ?? null) as GraphSymbolRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    nodeId: row.nodeId,
    fileId: row.fileId,
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    exported: row.exported === 1,
  };
}

export function lookupFile(db: DatabaseSync, filePath: string): GraphFile | null {
  const row = db
    .prepare(
      `
        SELECT id, path, language
        FROM files
        WHERE path = ?1
        LIMIT 1
      `,
    )
    .get(filePath) as GraphFileRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    path: row.path,
    language: row.language,
  };
}

