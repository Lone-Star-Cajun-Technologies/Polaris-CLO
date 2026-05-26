import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent, AuditEventType } from "../../types/runtime-state.js";
import { getArtifactDir } from "../state.js";

export async function readAuditLog(artifactDir: string): Promise<AuditEvent[]> {
  const auditFile = path.join(getArtifactDir(artifactDir), "audit.jsonl");
  try {
    const raw = await readFile(auditFile, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const events: AuditEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch (parseErr) {
        throw new Error(
          `Audit log corruption detected in ${auditFile}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
      }
    }
    return events;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function findLastEvent(
  log: AuditEvent[],
  eventType: AuditEventType,
  run_id: string,
  step_cursor: string,
): AuditEvent | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.event_type === eventType && e.run_id === run_id && e.step_cursor === step_cursor) {
      return e;
    }
  }
  return undefined;
}
