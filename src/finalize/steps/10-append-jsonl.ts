import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LoopState } from "../../loop/checkpoint.js";

export function stepAppendJsonl(telemetryFile: string, state: LoopState, prUrl: string): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  const ts = new Date().toISOString();

  const prOpened = {
    event: "pr-opened",
    run_id: state.run_id,
    pr_url: prUrl,
    timestamp: ts,
  };
  const runComplete = {
    event: "run-complete",
    run_id: state.run_id,
    children_completed: state.completed_children.length,
    timestamp: ts,
  };

  appendFileSync(telemetryFile, JSON.stringify(prOpened) + "\n", "utf-8");
  appendFileSync(telemetryFile, JSON.stringify(runComplete) + "\n", "utf-8");
}
