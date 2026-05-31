import { InvokeError, invokePolarisJson } from "../lib/invoke.js";
import { resolveRepoRoot } from "../lib/root.js";

interface BudgetFields {
  children_completed?: number;
  max_children_per_session?: number;
  [key: string]: unknown;
}

interface StatusPayload {
  run_id?: string;
  cluster_id?: string;
  status?: string;
  active_child?: string | null;
  completed_children?: string[];
  open_children?: string[];
  step_cursor?: string;
  context_budget?: BudgetFields;
  [key: string]: unknown;
}

function normalizeBudget(
  budget: BudgetFields | undefined,
): { children_completed: number; max_children_per_session: number; remaining: number } | undefined {
  if (!budget) return undefined;
  const completed = typeof budget.children_completed === "number" ? budget.children_completed : 0;
  const max =
    typeof budget.max_children_per_session === "number" ? budget.max_children_per_session : 3;
  return {
    children_completed: completed,
    max_children_per_session: max,
    remaining: Math.max(0, max - completed),
  };
}

function buildStatusResponse(raw: unknown): Record<string, unknown> {
  const p = raw as StatusPayload;
  return {
    ok: true,
    run_id: p.run_id ?? null,
    cluster_id: p.cluster_id ?? null,
    status: p.status ?? null,
    active_child: p.active_child ?? null,
    completed_children: p.completed_children ?? [],
    open_children: p.open_children ?? [],
    step_cursor: p.step_cursor ?? null,
    context_budget: normalizeBudget(p.context_budget),
  };
}

function errorResponse(
  error: string,
  message: string,
  hint?: string,
): Record<string, unknown> {
  const r: Record<string, unknown> = { ok: false, error, message };
  if (hint) r["hint"] = hint;
  return r;
}

export async function handlePolarisStatus(): Promise<Record<string, unknown>> {
  const repoRoot = resolveRepoRoot();
  try {
    const raw = invokePolarisJson(repoRoot, ["status", "--json"]);
    return buildStatusResponse(raw);
  } catch (err) {
    if (err instanceof InvokeError) {
      const isNotFound =
        err.stderr.includes("cannot read state file") || err.message.includes("cannot read");
      return errorResponse(
        isNotFound ? "state_not_found" : "invoke_failed",
        err.message,
        isNotFound ? "Run a polaris cluster session first to create current-state.json" : undefined,
      );
    }
    return errorResponse("unknown", String(err));
  }
}

export async function handlePolarisLoopStatus(): Promise<Record<string, unknown>> {
  const repoRoot = resolveRepoRoot();
  try {
    const raw = invokePolarisJson(repoRoot, ["loop", "status", "--json"]);
    return buildStatusResponse(raw);
  } catch (err) {
    if (err instanceof InvokeError) {
      const isNotFound =
        err.stderr.includes("cannot read state file") || err.message.includes("cannot read");
      return errorResponse(
        isNotFound ? "state_not_found" : "invoke_failed",
        err.message,
        isNotFound ? "Run a polaris cluster session first to create current-state.json" : undefined,
      );
    }
    return errorResponse("unknown", String(err));
  }
}
