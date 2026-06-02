import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanAdoptionInventory as scanRepoAdoptionInventory } from "./adoption-inventory.js";
import type { RepoScanInventory } from "./adoption-plan.js";

export interface ScanRepoOptions {
  now?: Date;
  rescan?: boolean;
}

function readExistingInventory(repoRoot: string): RepoScanInventory | null {
  const inventoryPath = join(repoRoot, ".polaris", "adoption-inventory.json");
  if (!existsSync(inventoryPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(inventoryPath, "utf-8")) as RepoScanInventory;
  } catch {
    return null;
  }
}

export async function scanRepo(
  repoRoot: string,
  options: ScanRepoOptions = {},
): Promise<RepoScanInventory> {
  const existingInventory = options.rescan ? null : readExistingInventory(repoRoot);
  if (existingInventory) {
    return existingInventory;
  }

  return scanRepoAdoptionInventory(repoRoot, { now: options.now, writeArtifact: true });
}
