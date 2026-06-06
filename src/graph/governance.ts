import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphInvalidationTrigger, PolarisConfig } from "../config/schema.js";

type InvalidationReason = "config-change" | "repo-change";

interface GraphGovernanceState {
  configHash: string;
  headCommit: string;
}

export interface GraphInvalidationResult {
  stale: boolean;
  reason?: InvalidationReason;
}

const DEFAULT_GRAPH_OUTPUT_PATH = ".polaris/graph";
const DEFAULT_INVALIDATION_TRIGGERS: GraphInvalidationTrigger[] = [
  "repo-change",
  "config-change",
];
const NOTICES_FILE_NAME = "NOTICES";
const GOVERNANCE_STATE_FILE = "governance-state.json";

export function writeGraphNotices(outputPath: string, notices: string[]): void {
  const absoluteOutputPath = resolve(outputPath);
  const noticesPath = resolve(absoluteOutputPath, NOTICES_FILE_NAME);
  const content = buildNoticesContent(notices);

  mkdirSync(absoluteOutputPath, { recursive: true });

  if (existsSync(noticesPath)) {
    const existing = readFileSync(noticesPath, "utf-8");
    if (existing === content) {
      return;
    }
  }

  writeFileSync(noticesPath, content, "utf-8");
}

export function checkGraphInvalidation(config: PolarisConfig, repoRoot: string): GraphInvalidationResult {
  const graphOutputPath = resolve(repoRoot, config.graph?.outputPath ?? DEFAULT_GRAPH_OUTPUT_PATH);
  const triggers = config.graph?.invalidationTriggers ?? DEFAULT_INVALIDATION_TRIGGERS;
  const currentState: GraphGovernanceState = {
    configHash: hashConfig(config),
    headCommit: resolveHeadCommit(repoRoot),
  };
  const previousState = readGovernanceState(graphOutputPath);

  if (previousState && triggers.includes("config-change") && previousState.configHash !== currentState.configHash) {
    return { stale: true, reason: "config-change" };
  }

  if (previousState && triggers.includes("repo-change") && previousState.headCommit !== currentState.headCommit) {
    return { stale: true, reason: "repo-change" };
  }

  return { stale: false };
}

export function recordGraphGovernanceState(graphOutputPath: string, state: GraphGovernanceState): void {
  writeGovernanceState(graphOutputPath, state);
}

function buildNoticesContent(notices: string[]): string {
  const cleaned = [...new Set(notices.map((notice) => notice.trim()).filter((notice) => notice.length > 0))];
  if (cleaned.length === 0) {
    return "# NOTICES\n\nNo third-party attributions recorded.\n";
  }

  return `# NOTICES\n\n${cleaned.join("\n\n")}\n`;
}

export function hashConfig(config: PolarisConfig): string {
  const normalized = stableSerialize(config);
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${pairs.join(",")}}`;
}

export function resolveHeadCommit(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
}

function readGovernanceState(graphOutputPath: string): GraphGovernanceState | null {
  const statePath = resolve(graphOutputPath, GOVERNANCE_STATE_FILE);
  if (!existsSync(statePath)) {
    return null;
  }

  let parsed: Partial<GraphGovernanceState>;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<GraphGovernanceState>;
  } catch {
    return null;
  }
  if (typeof parsed.configHash !== "string" || typeof parsed.headCommit !== "string") {
    return null;
  }

  return {
    configHash: parsed.configHash,
    headCommit: parsed.headCommit,
  };
}

function writeGovernanceState(graphOutputPath: string, state: GraphGovernanceState): void {
  const statePath = resolve(graphOutputPath, GOVERNANCE_STATE_FILE);
  mkdirSync(graphOutputPath, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}
