import type { GraphStoreAdapter } from "../store/adapter.js";
import { buildEdges, type ResolverBuildResult } from "./build-edges.js";
import { clearResolverStubs, resolveImports } from "./resolve-imports.js";

export interface GraphResolverOptions {
  graphStore: GraphStoreAdapter;
}

export interface GraphResolverResult extends ResolverBuildResult {
  resolvedImports: number;
}

export function runGraphResolver(options: GraphResolverOptions): GraphResolverResult {
  const db = options.graphStore.getDatabase();

  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    clearResolverStubs(db);
    const resolvedImports = resolveImports(db);
    const built = buildEdges(db, resolvedImports);
    db.exec("COMMIT");
    return {
      ...built,
      resolvedImports: resolvedImports.length,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
