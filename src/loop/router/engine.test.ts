import { describe, expect, it } from "vitest";
import { decideWorkerRoute } from "./engine.js";
import type { WorkerRouterInput } from "./types.js";

function baseInput(overrides: Partial<WorkerRouterInput> = {}): WorkerRouterInput {
  return {
    role: "worker",
    taskType: "impl",
    adapter: "terminal-cli",
    providers: ["copilot", "codex"],
    rotation: ["copilot", "codex"],
    compatibilityMode: false,
    routerPolicy: {
      allowCrossProviderFallback: true,
      defaultWorkerPool: { maxActiveSlots: 2 },
      providerRegistry: {
        copilot: {
          eligibleRoles: ["worker"],
          capabilities: ["implementation"],
          taskTypes: ["impl"],
          trustTier: "standard",
          costTier: "medium",
          quotaPolicy: "best-effort",
          fallbackEligible: true,
          maxActiveSlots: 2,
        },
        codex: {
          eligibleRoles: ["worker"],
          capabilities: ["implementation"],
          taskTypes: ["impl"],
          trustTier: "trusted",
          costTier: "medium",
          quotaPolicy: "best-effort",
          fallbackEligible: true,
          maxActiveSlots: 2,
        },
      },
    },
    ...overrides,
  };
}

describe("decideWorkerRoute", () => {
  it("selects the highest scoring eligible provider deterministically", () => {
    const input = baseInput();
    const first = decideWorkerRoute(input);
    const second = decideWorkerRoute(input);
    expect(first).toEqual(second);
    expect(first.selectedProvider).toBe("codex");
    expect(first.selectionReason).toBe("policy-router");
  });

  it("uses deterministic tie-break ordering by configured order then name", () => {
    const decision = decideWorkerRoute(
      baseInput({
        routerPolicy: {
          defaultWorkerPool: { maxActiveSlots: 2 },
          providerRegistry: {
            copilot: {
              eligibleRoles: ["worker"],
              capabilities: ["implementation"],
              taskTypes: ["impl"],
              trustTier: "standard",
              costTier: "medium",
            },
            codex: {
              eligibleRoles: ["worker"],
              capabilities: ["implementation"],
              taskTypes: ["impl"],
              trustTier: "standard",
              costTier: "medium",
            },
          },
        },
      }),
    );
    expect(decision.selectedProvider).toBe("copilot");
  });

  it("reports role-disabled when role policy disables provider usage", () => {
    const decision = decideWorkerRoute(
      baseInput({
        rolePolicy: { providers: [] },
      }),
    );
    expect(decision.selectedProvider).toBeUndefined();
    expect(decision.exhaustedReason).toBe("role-disabled");
  });

  it("reports not-in-policy for provider override excluded from role policy", () => {
    const decision = decideWorkerRoute(
      baseInput({
        providerOverride: "copilot",
        rolePolicy: { providers: ["codex"] },
      }),
    );
    expect(decision.selectedProvider).toBeUndefined();
    expect(decision.exhaustedReason).toBe("not-in-policy");
  });

  it("reports trust-too-low, cost-policy, quota-exhausted, and no-slot rejection reasons", () => {
    const decision = decideWorkerRoute(
      baseInput({
        constraints: {
          minTrustTier: "trusted",
          maxCostTier: "low",
          disallowedQuotaPolicies: ["rate-limited"],
          requiredCapabilities: ["implementation"],
        },
        runtime: {
          quotaAvailableByProvider: {
            copilot: false,
            codex: false,
          },
          activeSlotsByProvider: {
            copilot: 5,
            codex: 5,
          },
        },
        routerPolicy: {
          defaultWorkerPool: { maxActiveSlots: 1 },
          providerRegistry: {
            copilot: {
              eligibleRoles: ["worker"],
              capabilities: ["implementation"],
              taskTypes: ["impl"],
              trustTier: "standard",
              costTier: "high",
              quotaPolicy: "rate-limited",
              maxActiveSlots: 1,
            },
            codex: {
              eligibleRoles: ["worker"],
              capabilities: ["implementation"],
              taskTypes: ["impl"],
              trustTier: "standard",
              costTier: "high",
              quotaPolicy: "rate-limited",
              maxActiveSlots: 1,
            },
          },
        },
      }),
    );
    const allReasons = new Set(decision.candidates.flatMap((candidate) => candidate.rejectionReasons));
    expect(allReasons.has("trust-too-low")).toBe(true);
    expect(allReasons.has("cost-policy")).toBe(true);
    expect(allReasons.has("quota-exhausted")).toBe(true);
    expect(allReasons.has("no-slot")).toBe(true);
  });

  it("reports capability-mismatch when task or capability requirements do not match", () => {
    const decision = decideWorkerRoute(
      baseInput({
        taskType: "repair",
      }),
    );
    expect(decision.selectedProvider).toBeUndefined();
    expect(decision.exhaustedReason).toBe("capability-mismatch");
  });

  it("preserves compatibility mode selection ordering", () => {
    const decision = decideWorkerRoute(
      baseInput({
        compatibilityMode: true,
        routerPolicy: {
          defaultWorkerPool: { maxActiveSlots: 1 },
          providerRegistry: {},
        },
        rolePolicy: { providers: ["codex", "copilot"] },
        rotation: ["copilot"],
      }),
    );
    expect(decision.selectedProvider).toBe("copilot");
    expect(decision.selectionReason).toBe("policy-filtered-rotation");
  });
});

