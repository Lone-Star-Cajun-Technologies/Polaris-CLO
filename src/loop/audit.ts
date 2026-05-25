import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent } from "../types/runtime-state.js";
import { getRunDir } from "./state.js";

export async function appendAuditEvent(
  runId: string,
  event: Omit<AuditEvent, "timestamp">
): Promise<void> {
  const runDir = getRunDir(runId);
  await mkdir(runDir, { recursive: true });
  const entry: AuditEvent = { timestamp: new Date().toISOString(), ...event };
  await appendFile(path.join(runDir, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
}
