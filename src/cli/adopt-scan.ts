import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanAdoptionInventory as scanRepoAdoptionInventory } from "./adoption-inventory.js";
import type { RepoScanInventory } from "./adoption-plan.js";

export interface ScanRepoOptions {
  now?: Date;
  rescan?: boolean;
}

function isValidRepoScanInventory(parsed: unknown): parsed is RepoScanInventory {
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  return (
    Array.isArray(obj.smartdocs_candidates) &&
    Array.isArray(obj.agent_instruction_files) &&
    typeof obj.scanned_at === "string"
  );
}

function readExistingInventory(repoRoot: string): RepoScanInventory | null {
  const inventoryPath = join(repoRoot, ".polaris", "adoption-inventory.json");
  if (!existsSync(inventoryPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(inventoryPath, "utf-8"));
    if (!isValidRepoScanInventory(parsed)) {
      console.warn("Cached inventory failed validation; performing fresh scan");
      return null;
    }
    return parsed;
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
