import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CurrentState } from "../types/runtime-state.js";

export function getRunsDir(): string {
  return path.join(process.cwd(), ".polaris", "runs");
}

export function getRunDir(runId: string): string {
  return path.join(getRunsDir(), runId);
}

export function getStateFilePath(runId: string): string {
  return path.join(getRunDir(runId), "current-state.json");
}

export async function loadState(runId: string): Promise<CurrentState | null> {
  try {
    const raw = await readFile(getStateFilePath(runId), "utf-8");
    return JSON.parse(raw) as CurrentState;
  } catch {
    return null;
  }
}

export async function listRunIds(): Promise<string[]> {
  try {
    const entries = await readdir(getRunsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
