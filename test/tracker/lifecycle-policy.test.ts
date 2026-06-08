import { describe, it, expect } from "vitest";
import {
  resolveLifecycleTransition,
  getDefaultLifecyclePolicy,
  validateLifecyclePolicy,
  type LifecycleTransitionEvent,
} from "../../src/tracker/lifecycle-policy.js";

describe("resolveLifecycleTransition", () => {
  it("should resolve child-dispatch to in_progress by default", () => {
    const result = resolveLifecycleTransition("child-dispatch");
    expect(result.targetState).toBe("in_progress");
    expect(result.skip).toBe(false);
    expect(result.evidenceRequirements).toEqual([]);
  });

  it("should resolve child-validation-passed to in_review by default (review-gated)", () => {
    const result = resolveLifecycleTransition("child-validation-passed");
    expect(result.targetState).toBe("in_review");
    expect(result.skip).toBe(false);
    expect(result.evidenceRequirements).toEqual(["validation_results", "worker_commit"]);
  });

  it("should resolve child-merged to done by default", () => {
    const result = resolveLifecycleTransition("child-merged");
    expect(result.targetState).toBe("done");
    expect(result.skip).toBe(false);
    expect(result.evidenceRequirements).toEqual(["merge_commit_hash"]);
  });

  it("should resolve parent-all-children-complete to in_review by default (review-gated)", () => {
    const result = resolveLifecycleTransition("parent-all-children-complete");
    expect(result.targetState).toBe("in_review");
    expect(result.skip).toBe(false);
    expect(result.evidenceRequirements).toEqual(["completed_children_summary"]);
  });

  it("should resolve parent-delivery-merged to done by default", () => {
    const result = resolveLifecycleTransition("parent-delivery-merged");
    expect(result.targetState).toBe("done");
    expect(result.skip).toBe(false);
    expect(result.evidenceRequirements).toEqual(["delivery_merge_commit_hash"]);
  });

  it("should resolve child-triage-required to blocked by default", () => {
    const result = resolveLifecycleTransition("child-triage-required");
    expect(result.targetState).toBe("blocked");
    expect(result.skip).toBe(false);
    expect(result.evidenceRequirements).toEqual(["triage_reason", "failure_details"]);
  });

  it("should resolve provider-failure-before-work to no_status_change by default (skip)", () => {
    const result = resolveLifecycleTransition("provider-failure-before-work");
    expect(result.targetState).toBe("no_status_change");
    expect(result.skip).toBe(true);
    expect(result.skipReason).toBe("Provider failure before repo work does not change implementation status");
    expect(result.evidenceRequirements).toEqual(["failure_error", "provider_context"]);
  });

  it("should use custom policy when provided", () => {
    const customPolicy = {
      childOnDispatch: "backlog",
      childOnValidationPassed: "done",
    };
    const result = resolveLifecycleTransition("child-dispatch", customPolicy);
    expect(result.targetState).toBe("backlog");
    expect(result.skip).toBe(false);
  });

  it("should skip provider-failure-before-work when policy says no_status_change", () => {
    const customPolicy = {
      providerFailureBeforeWork: "no_status_change",
    };
    const result = resolveLifecycleTransition("provider-failure-before-work", customPolicy);
    expect(result.targetState).toBe("no_status_change");
    expect(result.skip).toBe(true);
    expect(result.skipReason).toBeDefined();
  });

  it("should not skip provider-failure-before-work when policy says blocked", () => {
    const customPolicy = {
      providerFailureBeforeWork: "blocked" as const,
    };
    const result = resolveLifecycleTransition("provider-failure-before-work", customPolicy);
    expect(result.targetState).toBe("blocked");
    expect(result.skip).toBe(false);
    expect(result.skipReason).toBeUndefined();
  });

  it("should handle unknown events gracefully", () => {
    const result = resolveLifecycleTransition("unknown" as LifecycleTransitionEvent);
    expect(result.targetState).toBe("no_status_change");
    expect(result.skip).toBe(true);
    expect(result.skipReason).toContain("Unknown lifecycle event");
  });
});

describe("getDefaultLifecyclePolicy", () => {
  it("should return policy with review-gated defaults", () => {
    const policy = getDefaultLifecyclePolicy();
    expect(policy.childOnDispatch).toBe("in_progress");
    expect(policy.childOnValidationPassed).toBe("in_review");
    expect(policy.childOnMerged).toBe("done");
    expect(policy.parentOnAllChildrenComplete).toBe("in_review");
    expect(policy.parentOnDeliveryMerged).toBe("done");
    expect(policy.childOnTriageRequired).toBe("blocked");
    expect(policy.providerFailureBeforeWork).toBe("no_status_change");
  });
});

describe("validateLifecyclePolicy", () => {
  it("should validate a correct policy", () => {
    const policy = {
      childOnDispatch: "in_progress",
      childOnValidationPassed: "in_review",
      childOnMerged: "done",
      parentOnAllChildrenComplete: "in_review",
      parentOnDeliveryMerged: "done",
      childOnTriageRequired: "blocked",
      providerFailureBeforeWork: "no_status_change",
    };
    const result = validateLifecyclePolicy(policy);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should reject non-object policy", () => {
    const result = validateLifecyclePolicy("invalid");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Lifecycle policy must be an object");
  });

  it("should reject null policy", () => {
    const result = validateLifecyclePolicy(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Lifecycle policy must be an object");
  });

  it("should reject invalid lifecycle state values", () => {
    const policy = {
      childOnDispatch: "invalid_state",
    };
    const result = validateLifecyclePolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("childOnDispatch");
  });

  it("should reject non-string lifecycle state values", () => {
    const policy = {
      childOnDispatch: 123,
    };
    const result = validateLifecyclePolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("tracker.lifecyclePolicy.childOnDispatch must be a string");
  });

  it("should accept all valid lifecycle states", () => {
    const validStates = ["backlog", "in_progress", "in_review", "done", "blocked", "cancelled", "no_status_change"];
    for (const state of validStates) {
      const policy = { childOnDispatch: state };
      const result = validateLifecyclePolicy(policy);
      expect(result.valid).toBe(true);
    }
  });

  it("should validate multiple fields", () => {
    const policy = {
      childOnDispatch: "invalid",
      childOnValidationPassed: 123,
    };
    const result = validateLifecyclePolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it("should accept partial policy (undefined fields are valid)", () => {
    const policy = {
      childOnDispatch: "in_progress",
    };
    const result = validateLifecyclePolicy(policy);
    expect(result.valid).toBe(true);
  });

  it("should accept empty policy", () => {
    const policy = {};
    const result = validateLifecyclePolicy(policy);
    expect(result.valid).toBe(true);
  });
});