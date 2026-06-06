import { existsSync, watch } from "node:fs";
import { resolve, isAbsolute, dirname, basename } from "node:path";
import { readState } from "./checkpoint.js";

export interface WaitOptions {
  stateFile: string;
  repoRoot: string;
  /** Override child ID; defaults to active_child from state */
  childId?: string;
  /** Timeout in milliseconds (default: 30 minutes) */
  timeoutMs?: number;
  /** Poll interval fallback in ms for platforms where fs.watch is unreliable (default: 5000) */
  pollIntervalMs?: number;
}

export function runLoopWait(options: WaitOptions): void {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;

  let state;
  try {
    state = readState(options.stateFile);
  } catch (err) {
    process.stderr.write(`Error: cannot read state file: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const childId = options.childId ?? state.active_child;
  if (!childId) {
    process.stdout.write(JSON.stringify({ status: "no-active-child" }) + "\n");
    return;
  }

  const meta = state.open_children_meta?.[childId];
  const rawResultPath = meta?.dispatch_record?.expected_result_path ?? meta?.result_file;
  if (!rawResultPath) {
    process.stderr.write(`Error: no expected_result_path found for child ${childId}\n`);
    process.exit(1);
  }

  const resultPath = isAbsolute(rawResultPath)
    ? rawResultPath
    : resolve(options.repoRoot, rawResultPath);

  if (existsSync(resultPath)) {
    process.stdout.write(JSON.stringify({ status: "result-ready", child_id: childId, result_path: resultPath }) + "\n");
    return;
  }

  process.stderr.write(`Waiting for result file: ${resultPath}\n`);
  process.stderr.write(`Child: ${childId} | Timeout: ${timeoutMs}ms\n`);

  const deadline = Date.now() + timeoutMs;
  let watcher: ReturnType<typeof watch> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let resolved = false;

  function succeed(): void {
    if (resolved) return;
    resolved = true;
    watcher?.close();
    if (pollTimer) clearInterval(pollTimer);
    process.stdout.write(JSON.stringify({ status: "result-ready", child_id: childId, result_path: resultPath }) + "\n");
    process.exit(0);
  }

  function checkTimeout(): void {
    if (resolved) return;
    resolved = true;
    watcher?.close();
    if (pollTimer) clearInterval(pollTimer);
    process.stderr.write(`Timeout: result file not found after ${timeoutMs}ms\n`);
    process.stdout.write(JSON.stringify({ status: "timeout", child_id: childId, result_path: resultPath }) + "\n");
    process.exit(1);
  }

  pollTimer = setInterval(() => {
    if (Date.now() > deadline) {
      checkTimeout();
      return;
    }
    if (existsSync(resultPath)) {
      succeed();
    }
  }, pollIntervalMs);

  // fs.watch for faster detection
  try {
    const resultDir = dirname(resultPath);
    const resultFile = basename(resultPath);
    watcher = watch(resultDir, (eventType, filename) => {
      if (filename === resultFile && existsSync(resultPath)) {
        succeed();
      }
    });
  } catch {
    // fs.watch unavailable — poll fallback is active
  }

  setTimeout(checkTimeout, timeoutMs);
}
