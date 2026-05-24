/**
 * Budget policy for the parent scheduler loop.
 *
 * The parent checks budget after each worker dispatch. If the budget is
 * exhausted, the parent halts and writes a checkpoint to current-state.json.
 */

import type { PolarisConfig } from "../config/schema.js";

export type BudgetMode = "fixed-cap" | "run-until-done" | "stop-on-fail";

export interface BudgetPolicy {
  /** Budget enforcement mode. */
  mode: BudgetMode;
  /** Maximum number of children to complete per session (fixed-cap mode). */
  maxChildrenPerSession: number;
  /** Halt immediately when any child returns status "failed". */
  stopOnFail: boolean;
}

export interface BudgetCheckInput {
  childrenCompleted: number;
  /** If provided, the status returned by the last completed worker. */
  lastChildStatus?: string;
  policy: BudgetPolicy;
}

export type BudgetCheckResult =
  | { status: 'ok' }
  | { status: 'exhausted'; reason: string };

/**
 * Check whether the context budget allows continuing to the next child.
 *
 * Returns `{ status: 'ok' }` if the loop should continue, or
 * `{ status: 'exhausted', reason }` if the loop must halt.
 */
export function checkBudget(input: BudgetCheckInput): BudgetCheckResult {
  const { childrenCompleted, lastChildStatus, policy } = input;

  // stop-on-fail: halt immediately when any child fails
  if (policy.stopOnFail && lastChildStatus === 'failed') {
    return {
      status: 'exhausted',
      reason: `Budget halted: stop_on_fail is enabled and a child returned status "failed".`,
    };
  }

  switch (policy.mode) {
    case 'run-until-done':
      // No cap — always continue until open_children is empty
      return { status: 'ok' };

    case 'stop-on-fail':
      // The stop-on-fail mode implies run-until-done cap-wise;
      // actual fail detection is handled above via stopOnFail flag.
      return { status: 'ok' };

    case 'fixed-cap':
    default:
      if (childrenCompleted >= policy.maxChildrenPerSession) {
        return {
          status: 'exhausted',
          reason:
            `Budget exhausted: ${childrenCompleted} of ${policy.maxChildrenPerSession} ` +
            `children completed this session.`,
        };
      }
      return { status: 'ok' };
  }
}

/**
 * Derive a BudgetPolicy from the state's context_budget field and the loaded config.
 * Config takes precedence over state fields; falls back to a default of 3-child fixed-cap.
 */
export function policyFromConfig(
  contextBudget: { max_children_per_session?: number },
  budgetConfig?: PolarisConfig['budget'],
): BudgetPolicy {
  const mode: BudgetMode = budgetConfig?.mode ?? 'fixed-cap';
  const maxChildrenPerSession =
    budgetConfig?.max_children ?? contextBudget.max_children_per_session ?? 3;
  const stopOnFail = budgetConfig?.stop_on_fail ?? false;

  return { mode, maxChildrenPerSession, stopOnFail };
}

/**
 * @deprecated Use policyFromConfig instead.
 * Kept for backwards compatibility with callers that only have state context_budget.
 */
export function policyFromState(contextBudget: {
  max_children_per_session?: number;
}): BudgetPolicy {
  return policyFromConfig(contextBudget, undefined);
}
