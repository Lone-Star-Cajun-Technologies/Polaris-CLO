import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface FileRouteEntry {
  domain: string;
  route: string;
  taskchain: string;
  confidence: number;
  classification: "indexed" | "tracked-not-indexed" | "needs-review";
  last_updated: string;
  updated_by: string;
  tags: string[];
}

export interface AtlasIndex {
  scan_date: string;
  file_count: number;
  coverage_pct: number;
  entries: Record<string, FileRouteEntry>;
}

export interface ExemptionEntry {
  classification: "tracked-not-indexed" | "ignored";
  reason: string;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as Error & { code?: string }).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function readFileRoutes(outputPath: string): Record<string, FileRouteEntry> {
  return readJson(resolve(outputPath, "file-routes.json"), {});
}

export function writeFileRoutes(outputPath: string, routes: Record<string, FileRouteEntry>): void {
  writeJson(resolve(outputPath, "file-routes.json"), routes);
}

export function readNeedsReview(outputPath: string): Record<string, FileRouteEntry> {
  return readJson(resolve(outputPath, "needs-review.json"), {});
}

export function writeNeedsReview(outputPath: string, entries: Record<string, FileRouteEntry>): void {
  writeJson(resolve(outputPath, "needs-review.json"), entries);
}

export function readExemptions(outputPath: string): Record<string, ExemptionEntry> {
  return readJson(resolve(outputPath, "exemptions.json"), {});
}

export function writeExemptions(outputPath: string, entries: Record<string, ExemptionEntry>): void {
  writeJson(resolve(outputPath, "exemptions.json"), entries);
}

export function writeAtlasIndex(outputPath: string, index: AtlasIndex): void {
  writeJson(resolve(outputPath, "index.json"), index);
}
