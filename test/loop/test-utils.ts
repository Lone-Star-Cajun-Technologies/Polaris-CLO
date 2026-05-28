import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { LoopState } from "../../src/loop/checkpoint.js";

/** Creates a unique temporary directory for a test. */
export function makeTempDir(): string {
  const dir = join(tmpdir(), `polaris-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a LoopState object to a current-state.json file within the test directory. */
export function writeStateFile(dir: string, state: Partial<LoopState> & { run_id: string }): string {
  const stateDir = join(dir, ".polaris", "runs");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "current-state.json");
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

/** Reads a LoopState object from a current-state.json file. */
export function readStateFile(stateFile: string): LoopState {
  return JSON.parse(readFileSync(stateFile, "utf-8")) as LoopState;
}

/** Capture stderr output during a function call. */
export function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Buffer) => {
    chunks.push(chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

/** Capture console.error output during a function call. */
export function captureConsoleError(fn: () => void): string {
  const chunks: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => chunks.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return chunks.join("\n");
}
