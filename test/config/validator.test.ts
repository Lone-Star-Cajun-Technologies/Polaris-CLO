import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/config/validator.js";

describe("validateConfig - tracker lifecyclePolicy", () => {
  it("should accept valid lifecycle policy", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnDispatch: "in_progress",
          childOnValidationPassed: "in_review",
          childOnMerged: "done",
          parentOnAllChildrenComplete: "in_review",
          parentOnDeliveryMerged: "done",
          childOnTriageRequired: "blocked",
          providerFailureBeforeWork: "no_status_change",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should accept partial lifecycle policy", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnDispatch: "in_progress",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should reject lifecycle policy that is not an object", () => {
    const config = {
      tracker: {
        lifecyclePolicy: "invalid",
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("tracker.lifecyclePolicy must be an object");
  });

  it("should reject invalid lifecycle state in childOnDispatch", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnDispatch: "invalid_state",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("childOnDispatch"))).toBe(true);
  });

  it("should reject invalid lifecycle state in childOnValidationPassed", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnValidationPassed: "invalid_state",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("childOnValidationPassed"))).toBe(true);
  });

  it("should reject invalid lifecycle state in childOnMerged", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnMerged: "invalid_state",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("childOnMerged"))).toBe(true);
  });

  it("should reject invalid lifecycle state in parentOnAllChildrenComplete", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          parentOnAllChildrenComplete: "invalid_state",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("parentOnAllChildrenComplete"))).toBe(true);
  });

  it("should reject invalid lifecycle state in parentOnDeliveryMerged", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          parentOnDeliveryMerged: "invalid_state",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("parentOnDeliveryMerged"))).toBe(true);
  });

  it("should reject invalid lifecycle state in childOnTriageRequired", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnTriageRequired: "invalid_state",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("childOnTriageRequired"))).toBe(true);
  });

  it("should reject invalid lifecycle state in providerFailureBeforeWork", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          providerFailureBeforeWork: "invalid_state",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("providerFailureBeforeWork"))).toBe(true);
  });

  it("should accept all valid lifecycle states", () => {
    const validStates = ["backlog", "in_progress", "in_review", "done", "blocked", "cancelled", "no_status_change"];
    for (const state of validStates) {
      const config = {
        tracker: {
          lifecyclePolicy: {
            childOnDispatch: state,
          },
        },
      };
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
    }
  });

  it("should reject non-string lifecycle state value", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnDispatch: 123,
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("childOnDispatch"))).toBe(true);
  });

  it("should accept config without tracker section", () => {
    const config = {};
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("should accept config with tracker section but no lifecycle policy", () => {
    const config = {
      tracker: {
        adapter: "linear",
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("should validate lifecycle policy alongside other tracker config", () => {
    const config = {
      tracker: {
        adapter: "linear",
        lifecyclePolicy: {
          childOnDispatch: "in_progress",
        },
        linear: {
          enabled: true,
          teamId: "test-team",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it("should report multiple lifecycle policy errors", () => {
    const config = {
      tracker: {
        lifecyclePolicy: {
          childOnDispatch: "invalid1",
          childOnValidationPassed: "invalid2",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});