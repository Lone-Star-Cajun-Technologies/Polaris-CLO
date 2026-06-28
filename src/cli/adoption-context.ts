import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OperatorContext {
  schema_version: "1.0";
  answered_at: string;
  trusted_docs: string[];
  stale_docs: string[];
  never_touch: string[];
  priority_systems: string[];
  instruction_file_intent: Record<string, "preserve" | "migrate" | "thin-adapter">;
}

const ADOPTION_DIR = join(".polaris", "adoption");
const CONTEXT_FILE = "operator-context.json";

function contextPath(repoRoot: string): string {
  return join(repoRoot, ADOPTION_DIR, CONTEXT_FILE);
}

export function loadOperatorContext(repoRoot: string): OperatorContext | null {
  const path = contextPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as OperatorContext;
  } catch {
    return null;
  }
}

export function saveOperatorContext(repoRoot: string, context: OperatorContext): void {
  mkdirSync(join(repoRoot, ADOPTION_DIR), { recursive: true });
  writeFileSync(contextPath(repoRoot), `${JSON.stringify(context, null, 2)}\n`, "utf-8");
}

export function createEmptyOperatorContext(now?: Date): OperatorContext {
  return {
    schema_version: "1.0",
    answered_at: (now ?? new Date()).toISOString(),
    trusted_docs: [],
    stale_docs: [],
    never_touch: [],
    priority_systems: [],
    instruction_file_intent: {},
  };
}
