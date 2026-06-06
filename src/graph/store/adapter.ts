import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeGraphNotices } from "../governance.js";
import { CURRENT_GRAPH_SCHEMA_VERSION } from "./types.js";

const MIT_NOTICE = "Includes concepts derived from an MIT-licensed graph indexing approach.";
const FALLBACK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  file_id TEXT NOT NULL,
  name TEXT,
  start_line INTEGER,
  start_column INTEGER,
  end_line INTEGER,
  end_column INTEGER,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  exported INTEGER NOT NULL DEFAULT 0 CHECK (exported IN (0, 1)),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  metadata TEXT,
  FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  UNIQUE (type, from_node_id, to_node_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_file_id ON nodes(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_from_node_id ON edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_node_id ON edges(to_node_id);
`;

export interface GraphStoreAdapterOptions {
  dbPath: string;
  graphOutputPath?: string;
  repoRoot?: string;
}

export class GraphStoreAdapter {
  private readonly dbPath: string;
  private readonly noticesOutputPath: string;
  private db: DatabaseSync | null = null;
  private initialized = false;

  constructor(options: GraphStoreAdapterOptions) {
    this.dbPath = resolve(options.repoRoot ?? process.cwd(), options.dbPath);
    this.noticesOutputPath = resolve(
      options.repoRoot ?? process.cwd(),
      options.graphOutputPath ?? ".polaris/graph",
    );
  }

  open(): DatabaseSync {
    if (this.db) {
      return this.db;
    }

    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
    return this.db;
  }

  close(): void {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
  }

  getDatabase(): DatabaseSync {
    if (!this.db) {
      throw new Error("Graph store is not open.");
    }

    return this.db;
  }

  initSchema(): void {
    const db = this.getDatabase();
    db.exec(loadSchemaSql());
    const appliedVersion = getAppliedSchemaVersion(db);

    if (appliedVersion > CURRENT_GRAPH_SCHEMA_VERSION) {
      throw new Error(
        `Graph schema version ${appliedVersion} is newer than supported ${CURRENT_GRAPH_SCHEMA_VERSION}.`,
      );
    }

    for (let version = appliedVersion + 1; version <= CURRENT_GRAPH_SCHEMA_VERSION; version += 1) {
      db.prepare(
        `
          INSERT OR IGNORE INTO schema_version (version, applied_at)
          VALUES (?1, CURRENT_TIMESTAMP)
        `,
      ).run(version);
    }

    if (!this.initialized) {
      writeGraphNotices(this.noticesOutputPath, [MIT_NOTICE]);
      this.initialized = true;
    }
  }
}

function loadSchemaSql(): string {
  const schemaPath = resolve(__dirname, "schema.sql");
  try {
    return readFileSync(schemaPath, "utf-8");
  } catch {
    return FALLBACK_SCHEMA_SQL;
  }
}

function getAppliedSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare(
      `
        SELECT MAX(version) AS version
        FROM schema_version
      `,
    )
    .get() as { version: number | null } | undefined;

  return row?.version ?? 0;
}
