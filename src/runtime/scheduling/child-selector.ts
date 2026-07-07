import type { CurrentState } from "../../types/runtime-state.js";
import type { WorkerRouterDecision } from "../../loop/router/index.js";

/**
 * Select the next child to execute.
 *
 * TODO: TEMPORARY — lexical sort of issue IDs is a placeholder only.
 * Real scheduling must come from runtime orchestration policy (priority,
 * dependencies, cycle assignment, etc.). Do not treat this ordering as
 * authoritative. Replace with a SchedulingService in a future cluster.
 */
export function selectNextChild(state: CurrentState): string | null {
  if (state.open_children.length === 0) return null;
  return [...state.open_children].sort()[0] ?? null;
}

export interface SlotClaim {
  child_id: string;
  provider: string | null;
  claimed_at: string;
  expires_at: string;
  selection_reason: string;
}

export interface SlotClaimSelection {
  child_id: string;
  decision: WorkerRouterDecision;
}

export interface SelectChildSlotClaimsArgs {
  open_children: string[];
  completed_children: string[];
  active_child: string | null;
  existing_claims: SlotClaim[];
  max_concurrent: number;
  claim_ttl_ms: number;
  now?: Date;
  get_dependencies: (childId: string) => string[];
  decide_route: (input: { childId: string; activeSlotsByProvider: Record<string, number> }) => WorkerRouterDecision;
}

export interface SelectChildSlotClaimsResult {
  selected_child: string | null;
  slot_claims: SlotClaim[];
  rejected_children: Record<string, "blocked-dependency" | "router-ineligible">;
  expired_claims: string[];
}

function countActiveSlotsByProvider(claims: SlotClaim[]): Record<string, number> {
  const activeSlotsByProvider: Record<string, number> = {};
  for (const claim of claims) {
    if (!claim.provider) continue;
    activeSlotsByProvider[claim.provider] = (activeSlotsByProvider[claim.provider] ?? 0) + 1;
  }
  return activeSlotsByProvider;
}

export function selectChildSlotClaims(args: SelectChildSlotClaimsArgs): SelectChildSlotClaimsResult {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  const openSet = new Set(args.open_children);
  const completedSet = new Set(args.completed_children);

  const expired_claims: string[] = [];
  const retainedClaims = args.existing_claims.filter((claim) => {
    const expiresAt = new Date(claim.expires_at).getTime();
    const notExpired = Number.isFinite(expiresAt) && expiresAt > nowMs;
    const stillOpen = openSet.has(claim.child_id);
    if (!notExpired || !stillOpen) {
      expired_claims.push(claim.child_id);
      return false;
    }
    return true;
  });

  const activeSlotsByProvider = countActiveSlotsByProvider(retainedClaims);
  const rejected_children: Record<string, "blocked-dependency" | "router-ineligible"> = {};
  const claimedChildren = new Set(retainedClaims.map((claim) => claim.child_id));
  const availableSlots = Math.max(0, args.max_concurrent - retainedClaims.length);

  const newClaims: SlotClaim[] = [];
  if (availableSlots > 0) {
    for (const childId of args.open_children) {
      if (newClaims.length >= availableSlots) break;
      if (childId === args.active_child) continue;
      if (claimedChildren.has(childId)) continue;

      const dependencies = args.get_dependencies(childId);
      const unmetDependencies = dependencies.filter((dependency) => openSet.has(dependency) && !completedSet.has(dependency));
      if (unmetDependencies.length > 0) {
        rejected_children[childId] = "blocked-dependency";
        continue;
      }

      const decision = args.decide_route({
        childId,
        activeSlotsByProvider: {
          ...activeSlotsByProvider,
          ...countActiveSlotsByProvider(newClaims),
        },
      });

      const hardIneligibleReasons = new Set([
        "role-disabled",
        "not-in-policy",
        "quota-exhausted",
        "trust-too-low",
        "capability-mismatch",
        "cost-policy",
        "no-slot",
      ]);
      const routingExhausted =
        decision.exhaustedReason !== undefined &&
        (hardIneligibleReasons.has(decision.exhaustedReason) || decision.mode !== "delegated");
      const canClaim = decision.selectedProvider !== undefined || decision.mode === "delegated";
      if (routingExhausted || !canClaim) {
        rejected_children[childId] = "router-ineligible";
        continue;
      }

      newClaims.push({
        child_id: childId,
        provider: decision.selectedProvider ?? null,
        claimed_at: now.toISOString(),
        expires_at: new Date(nowMs + args.claim_ttl_ms).toISOString(),
        selection_reason: decision.selectionReason,
      });
    }
  }

  const slot_claims = [...retainedClaims, ...newClaims];
  return {
    selected_child: slot_claims[0]?.child_id ?? null,
    slot_claims,
    rejected_children,
    expired_claims,
  };
}
