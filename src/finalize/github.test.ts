import { describe, it, expect } from "vitest";
import { buildPrBody } from "./github.js";
import type { LoopState } from "../loop/checkpoint.js";

describe("buildPrBody", () => {
  function makeState(completedChildren: string[]): LoopState {
    return {
      cluster_id: "POL-509",
      run_id: "polaris-run-pol-509",
      completed_children: completedChildren,
    } as unknown as LoopState;
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
});
