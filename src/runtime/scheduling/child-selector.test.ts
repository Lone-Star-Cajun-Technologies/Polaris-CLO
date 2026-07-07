import { describe, expect, it } from "vitest";
import type { WorkerRouterDecision } from "../../loop/router/index.js";
import { selectChildSlotClaims, type SlotClaim } from "./child-selector.js";

function makeDecision(
  provider: string | undefined,
  overrides: Partial<WorkerRouterDecision> = {},
): WorkerRouterDecision {
  return {
    selectedProvider: provider,
    selectedWorker: { role: "worker", taskType: "impl" },
    mode: provider ? "direct-worker" : "delegated",
    selectionReason: provider ? "policy-router" : "delegated-no-provider",
    compatibilityMode: false,
    providersTried: provider ? [provider] : [],
    candidates: [],
    ...overrides,
  };
}

describe("selectChildSlotClaims", () => {
  it("preserves one-slot compatibility by selecting only one child when max_concurrent=1", () => {
    const result = selectChildSlotClaims({
      open_children: ["POL-401", "POL-402"],
      completed_children: [],
      active_child: null,
      existing_claims: [],
      max_concurrent: 1,
      claim_ttl_ms: 30_000,
      get_dependencies: () => [],
      decide_route: () => makeDecision("codex"),
    });

    expect(result.selected_child).toBe("POL-401");
    expect(result.slot_claims.map((claim) => claim.child_id)).toEqual(["POL-401"]);
  });

  it("claims multiple slots and applies provider slot pressure to later selections", () => {
    const result = selectChildSlotClaims({
      open_children: ["POL-401", "POL-402", "POL-403"],
      completed_children: [],
      active_child: null,
      existing_claims: [],
      max_concurrent: 2,
      claim_ttl_ms: 30_000,
      get_dependencies: () => [],
      decide_route: ({ activeSlotsByProvider }) => {
        if ((activeSlotsByProvider["codex"] ?? 0) >= 1) {
          return makeDecision("copilot");
        }
        return makeDecision("codex");
      },
    });

    expect(result.slot_claims).toHaveLength(2);
    expect(result.slot_claims.map((claim) => claim.provider)).toEqual(["codex", "copilot"]);
  });

  it("excludes dependency-blocked children until blockers are complete", () => {
    const result = selectChildSlotClaims({
      open_children: ["POL-401", "POL-402"],
      completed_children: [],
      active_child: null,
      existing_claims: [],
      max_concurrent: 2,
      claim_ttl_ms: 30_000,
      get_dependencies: (childId) => (childId === "POL-402" ? ["POL-401"] : []),
      decide_route: () => makeDecision("codex"),
    });

    expect(result.slot_claims.map((claim) => claim.child_id)).toEqual(["POL-401"]);
    expect(result.rejected_children["POL-402"]).toBe("blocked-dependency");
  });

  it("expires stale claims and reclaims slots for fresh work", () => {
    const now = new Date("2026-07-07T10:00:00.000Z");
    const existing: SlotClaim[] = [
      {
        child_id: "POL-401",
        provider: "codex",
        claimed_at: "2026-07-07T09:00:00.000Z",
        expires_at: "2026-07-07T09:30:00.000Z",
        selection_reason: "policy-router",
      },
    ];
    const result = selectChildSlotClaims({
      open_children: ["POL-401", "POL-402"],
      completed_children: [],
      active_child: null,
      existing_claims: existing,
      max_concurrent: 1,
      claim_ttl_ms: 30_000,
      now,
      get_dependencies: () => [],
      decide_route: () => makeDecision("copilot"),
    });

    expect(result.expired_claims).toEqual(["POL-401"]);
    expect(result.slot_claims.map((claim) => claim.child_id)).toEqual(["POL-401"]);
    expect(result.slot_claims[0]?.provider).toBe("copilot");
  });

  it("assigns the next unblocked child after the in-flight child is no longer active", () => {
    const now = new Date("2026-07-07T10:00:00.000Z");
    const existing: SlotClaim[] = [
      {
        child_id: "POL-401",
        provider: "codex",
        claimed_at: "2026-07-07T09:59:00.000Z",
        expires_at: "2026-07-07T10:59:00.000Z",
        selection_reason: "policy-router",
      },
    ];

    const whileRunning = selectChildSlotClaims({
      open_children: ["POL-401", "POL-402"],
      completed_children: [],
      active_child: "POL-401",
      existing_claims: existing,
      max_concurrent: 1,
      claim_ttl_ms: 30_000,
      now,
      get_dependencies: () => [],
      decide_route: () => makeDecision("codex"),
    });
    expect(whileRunning.selected_child).toBe("POL-401");

    const afterFinish = selectChildSlotClaims({
      open_children: ["POL-402"],
      completed_children: ["POL-401"],
      active_child: null,
      existing_claims: whileRunning.slot_claims,
      max_concurrent: 1,
      claim_ttl_ms: 30_000,
      now: new Date("2026-07-07T10:01:00.000Z"),
      get_dependencies: () => [],
      decide_route: () => makeDecision("codex"),
    });
    expect(afterFinish.selected_child).toBe("POL-402");
    expect(afterFinish.slot_claims.map((claim) => claim.child_id)).toEqual(["POL-402"]);
  });

  it("sums retained and new claims for the same provider when computing activeSlotsByProvider", () => {
    // One retained "codex" claim exists for the active child. With two more open
    // children and max_concurrent=3 (two available slots), decide_route is called
    // twice. The second call must see codex count = 2 (retained + the newly claimed
    // slot from the first call), not just 1 (overwritten by a plain spread).
    const now = new Date("2026-07-07T10:00:00.000Z");
    const existing: SlotClaim[] = [
      {
        child_id: "POL-401",
        provider: "codex",
        claimed_at: "2026-07-07T09:59:00.000Z",
        expires_at: "2026-07-07T11:00:00.000Z",
        selection_reason: "policy-router",
      },
    ];
    const seenCounts: number[] = [];
    selectChildSlotClaims({
      open_children: ["POL-401", "POL-402", "POL-403"],
      completed_children: [],
      active_child: "POL-401",
      existing_claims: existing,
      max_concurrent: 3,
      claim_ttl_ms: 60_000,
      now,
      get_dependencies: () => [],
      decide_route: ({ activeSlotsByProvider }) => {
        seenCounts.push(activeSlotsByProvider["codex"] ?? 0);
        return makeDecision("codex");
      },
    });
    // First call (for POL-402): sees 1 retained codex slot.
    expect(seenCounts[0]).toBe(1);
    // Second call (for POL-403): sees retained + first newly claimed = 2 codex slots.
    expect(seenCounts[1]).toBe(2);
  });
});
