import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CurrentState } from "../types/runtime-state.js";

export function getArtifactsDir(): string {
  return path.join(process.cwd(), ".taskchain_artifacts");
}

export function getArtifactDir(artifactDir: string): string {
  return path.join(getArtifactsDir(), artifactDir);
}

export function getStateFilePath(artifactDir: string): string {
  return path.join(getArtifactDir(artifactDir), "current-state.json");
}

export async function loadState(artifactDir: string): Promise<CurrentState | null> {
  try {
    const raw = await readFile(getStateFilePath(artifactDir), "utf-8");
    return JSON.parse(raw) as CurrentState;
  } catch {
    return null;
  }
}

export async function listArtifactDirs(): Promise<string[]> {
  try {
    const entries = await readdir(getArtifactsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
