/**
 * Unit tests for budget policy evaluation (src/loop/budget.ts).
 *
 * Covers:
 * - fixed-cap mode: stop after max_children, continue before cap
 * - run-until-done mode: always continue regardless of count
 * - stop-on-fail mode: halt when lastChildStatus is "failed"
 * - stop_on_fail flag: halts across all modes when a child fails
 * - No-config default: 3-child fixed-cap (backwards compatibility)
 * - policyFromConfig: precedence of config over state
 * - policyFromState: backwards-compat shim
 */

import { describe, expect, it } from "vitest";
import { checkBudget, policyFromConfig, policyFromState } from "./budget.js";
import type { BudgetPolicy } from "./budget.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<BudgetPolicy> = {}): BudgetPolicy {
  return {
    mode: "fixed-cap",
    maxChildrenPerSession: 3,
    stopOnFail: false,
    ...overrides,
  };
}

// ── fixed-cap mode ────────────────────────────────────────────────────────────

describe("checkBudget / fixed-cap", () => {
  it("returns ok when children completed is below cap", () => {
    const result = checkBudget({
      childrenCompleted: 2,
      policy: makePolicy({ mode: "fixed-cap", maxChildrenPerSession: 3 }),
    });
    expect(result.status).toBe("ok");
  });

  it("returns exhausted when children completed equals cap", () => {
    const result = checkBudget({
      childrenCompleted: 3,
      policy: makePolicy({ mode: "fixed-cap", maxChildrenPerSession: 3 }),
    });
    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") {
      expect(result.reason).toMatch(/3 of 3/);
    }
  });

  it("returns exhausted when children completed exceeds cap", () => {
    const result = checkBudget({
      childrenCompleted: 5,
      policy: makePolicy({ mode: "fixed-cap", maxChildrenPerSession: 3 }),
    });
    expect(result.status).toBe("exhausted");
  });

  it("respects a custom cap of 5", () => {
    const policy = makePolicy({ mode: "fixed-cap", maxChildrenPerSession: 5 });
    // 4 done → ok
    expect(checkBudget({ childrenCompleted: 4, policy }).status).toBe("ok");
    // 5 done → exhausted
    expect(checkBudget({ childrenCompleted: 5, policy }).status).toBe("exhausted");
  });

  it("returns ok at 0 children with cap 3 (no-config default behavior)", () => {
    const result = checkBudget({
      childrenCompleted: 0,
      policy: makePolicy({ mode: "fixed-cap", maxChildrenPerSession: 3 }),
    });
    expect(result.status).toBe("ok");
  });
});

// ── run-until-done mode ───────────────────────────────────────────────────────

describe("checkBudget / run-until-done", () => {
  it("always returns ok regardless of children completed", () => {
    const policy = makePolicy({ mode: "run-until-done", maxChildrenPerSession: 3 });
    for (const n of [0, 3, 10, 100]) {
      expect(checkBudget({ childrenCompleted: n, policy }).status).toBe("ok");
    }
  });

  it("runs all open children without stopping at 3", () => {
    const policy = makePolicy({ mode: "run-until-done", maxChildrenPerSession: 3 });
    // Even at 50 completed, budget is not exhausted
    expect(checkBudget({ childrenCompleted: 50, policy }).status).toBe("ok");
  });
});

// ── stop-on-fail mode ─────────────────────────────────────────────────────────

describe("checkBudget / stop-on-fail mode", () => {
  it("returns ok when no child has failed", () => {
    const policy = makePolicy({ mode: "stop-on-fail", stopOnFail: true, maxChildrenPerSession: 100 });
    expect(checkBudget({ childrenCompleted: 5, policy }).status).toBe("ok");
  });

  it("does not halt on successful child status", () => {
    const policy = makePolicy({ mode: "stop-on-fail", stopOnFail: true, maxChildrenPerSession: 100 });
    expect(checkBudget({ childrenCompleted: 1, lastChildStatus: "done", policy }).status).toBe("ok");
  });
});

// ── stopOnFail flag (cross-mode) ──────────────────────────────────────────────

describe("checkBudget / stopOnFail flag", () => {
  it("halts when lastChildStatus is 'failed' and stopOnFail is true", () => {
    const policy = makePolicy({ mode: "fixed-cap", maxChildrenPerSession: 10, stopOnFail: true });
    const result = checkBudget({ childrenCompleted: 1, lastChildStatus: "failed", policy });
    expect(result.status).toBe("exhausted");
    if (result.status === "exhausted") {
      expect(result.reason).toMatch(/stop_on_fail/);
    }
  });

  it("does not halt when lastChildStatus is 'failed' but stopOnFail is false", () => {
    const policy = makePolicy({ mode: "fixed-cap", maxChildrenPerSession: 10, stopOnFail: false });
    const result = checkBudget({ childrenCompleted: 1, lastChildStatus: "failed", policy });
    expect(result.status).toBe("ok");
  });

  it("halts on failed child in run-until-done mode when stopOnFail is true", () => {
    const policy = makePolicy({ mode: "run-until-done", maxChildrenPerSession: 100, stopOnFail: true });
    const result = checkBudget({ childrenCompleted: 2, lastChildStatus: "failed", policy });
    expect(result.status).toBe("exhausted");
  });
});

// ── policyFromConfig ──────────────────────────────────────────────────────────

describe("policyFromConfig", () => {
  it("uses default 3-child fixed-cap when no config provided", () => {
    const policy = policyFromConfig({});
    expect(policy.mode).toBe("fixed-cap");
    expect(policy.maxChildrenPerSession).toBe(3);
    expect(policy.stopOnFail).toBe(false);
  });

  it("falls back to state max_children_per_session when no config budget", () => {
    const policy = policyFromConfig({ max_children_per_session: 7 });
    expect(policy.maxChildrenPerSession).toBe(7);
  });

  it("config max_children overrides state max_children_per_session", () => {
    const policy = policyFromConfig(
      { max_children_per_session: 2 },
      { mode: "fixed-cap", max_children: 5 },
    );
    expect(policy.maxChildrenPerSession).toBe(5);
  });

  it("reads run-until-done mode from config", () => {
    const policy = policyFromConfig({}, { mode: "run-until-done" });
    expect(policy.mode).toBe("run-until-done");
  });

  it("reads stop_on_fail from config", () => {
    const policy = policyFromConfig({}, { stop_on_fail: true });
    expect(policy.stopOnFail).toBe(true);
  });
});

// ── policyFromState (backwards compat) ────────────────────────────────────────

describe("policyFromState (backwards compat)", () => {
  it("returns 3-child fixed-cap when state has no max_children_per_session", () => {
    const policy = policyFromState({});
    expect(policy.mode).toBe("fixed-cap");
    expect(policy.maxChildrenPerSession).toBe(3);
  });

  it("respects max_children_per_session from state", () => {
    const policy = policyFromState({ max_children_per_session: 5 });
    expect(policy.maxChildrenPerSession).toBe(5);
  });
});

// ── no-config default backwards compatibility ─────────────────────────────────

describe("no-config default (backwards compatibility)", () => {
  it("defaults to 3-child fixed-cap with policyFromConfig and empty state", () => {
    const policy = policyFromConfig({}, undefined);
    expect(policy.mode).toBe("fixed-cap");
    expect(policy.maxChildrenPerSession).toBe(3);
    expect(policy.stopOnFail).toBe(false);
  });

  it("exhausts after 3 children with default policy", () => {
    const policy = policyFromConfig({}, undefined);
    expect(checkBudget({ childrenCompleted: 2, policy }).status).toBe("ok");
    expect(checkBudget({ childrenCompleted: 3, policy }).status).toBe("exhausted");
  });
});
