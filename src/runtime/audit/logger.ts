import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent } from "../../types/runtime-state.js";
import { getArtifactDir } from "../state.js";

export async function appendAuditEvent(
  artifactDir: string,
  event: Omit<AuditEvent, "timestamp">
): Promise<void> {
  const dir = getArtifactDir(artifactDir);
  await mkdir(dir, { recursive: true });
  const entry: AuditEvent = { timestamp: new Date().toISOString(), ...event };
  await appendFile(path.join(dir, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
}
