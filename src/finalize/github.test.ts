import { describe, it, expect } from "vitest";
import { buildPrBody } from "./github.js";
import type { LoopState } from "../loop/checkpoint.js";
import type { ProviderRoutingSummary } from "../loop/checkpoint.js";
import type { RouterOutcomesSummary } from "../autoresearch/score.js";

describe("buildPrBody", () => {
  function makeState(completedChildren: string[]): LoopState {
    return {
      cluster_id: "POL-509",
      run_id: "polaris-run-pol-509",
      completed_children: completedChildren,
    } as unknown as LoopState;
  }

  function makeRoutingSummary(overrides: Partial<ProviderRoutingSummary> = {}): ProviderRoutingSummary {
    return {
      selected_provider: "devin",
      selected_adapter: "terminal-cli",
      selection_reason: "role-policy",
      effective_policy_order: ["devin"],
      compatibility_mode: true,
      registry_present: false,
      fallback_eligible: false,
      ...overrides,
    };
  }

  function makeRouterOutcomes(
    overrides: Partial<RouterOutcomesSummary> = {},
  ): RouterOutcomesSummary {
    return {
      total_decisions: 1,
      exhausted_decisions: 0,
      fallback_attempts: 0,
      successful_fallbacks: 0,
      recurring_failures: [],
      provider_monopoly_signals: [],
      evidence_gap_signals: [],
      state_repair_signals: [],
      ...overrides,
    };
  }

  it("includes run metadata", () => {
    const body = buildPrBody(makeState(["POL-510", "POL-511", "POL-512"]), "pol-509-delivery");
    expect(body).toContain("**Cluster ID:** POL-509");
    expect(body).toContain("**Run ID:** polaris-run-pol-509");
    expect(body).toContain("**Branch:** pol-509-delivery");
  });

  it("uses state.completed_children.length when no authoritative count is provided", () => {
    const body = buildPrBody(makeState(["POL-510", "POL-511", "POL-512"]), "pol-509-delivery");
    expect(body).toContain("**Children completed:** 3");
  });

  it("uses the authoritative child count when provided", () => {
    const body = buildPrBody(makeState([]), "pol-509-delivery", 5);
    expect(body).toContain("**Children completed:** 5");
  });

  it("includes a provider routing section with selected provider, selection reason, and mode", () => {
    const body = buildPrBody(
      makeState(["POL-510"]),
      "pol-509-delivery",
      undefined,
      makeRoutingSummary(),
      makeRouterOutcomes(),
    );
    expect(body).toContain("### Provider routing");
    expect(body).toContain("**Selected provider:** devin");
    expect(body).toContain("**Selection reason:** role-policy");
    expect(body).toContain("**Mode:** compatibility");
    expect(body).toContain("**Policy order:** devin");
  });

  it("renders router mode when compatibility_mode is false", () => {
    const body = buildPrBody(
      makeState(["POL-510"]),
      "pol-509-delivery",
      undefined,
      makeRoutingSummary({ compatibility_mode: false }),
      makeRouterOutcomes(),
    );
    expect(body).toContain("**Mode:** router");
  });

  it("renders no routing anomalies when router outcomes are clean", () => {
    const body = buildPrBody(
      makeState(["POL-510"]),
      "pol-509-delivery",
      undefined,
      makeRoutingSummary(),
      makeRouterOutcomes(),
    );
    expect(body).toContain("**Routing review:** No routing anomalies detected.");
  });

  it("renders provider monopoly anomalies when present", () => {
    const body = buildPrBody(
      makeState(["POL-510"]),
      "pol-509-delivery",
      undefined,
      makeRoutingSummary(),
      makeRouterOutcomes({
        provider_monopoly_signals: [
          {
            signal: "provider-monopoly",
            reason: "devin",
            occurrences: 2,
            child_ids: ["POL-510", "POL-511"],
          },
        ],
      }),
    );
    expect(body).toContain("Provider monopoly (repeated same-provider selection):");
    expect(body).toContain("devin: 2 occurrence(s) — children: POL-510, POL-511");
  });

  it("omits the provider routing section when no routing evidence is provided", () => {
    const body = buildPrBody(makeState(["POL-510"]), "pol-509-delivery");
    expect(body).not.toContain("### Provider routing");
  });
});
