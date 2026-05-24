/**
 * Budget policy for the parent scheduler loop.
 *
 * The parent checks budget after each worker dispatch. If the budget is
 * exhausted, the parent halts and writes a checkpoint to current-state.json.
 */

export interface BudgetPolicy {
  /** Maximum number of children to complete per session. */
  maxChildrenPerSession: number;
}

export interface BudgetCheckInput {
  childrenCompleted: number;
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
  const { childrenCompleted, policy } = input;
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

/**
 * Derive a BudgetPolicy from the state's context_budget field.
 * Falls back to a default of 3 children per session if not configured.
 */
export function policyFromState(contextBudget: {
  max_children_per_session?: number;
}): BudgetPolicy {
  return {
    maxChildrenPerSession: contextBudget.max_children_per_session ?? 3,
  };
}
