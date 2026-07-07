import { describe, it, expect } from "vitest";
import type { QcFinding } from "./types.js";
import { resolveAttribution, buildChangedFileOwnership, type QcAttributionContext } from "./attribution.js";

function makeFinding(overrides: Partial<QcFinding> = {}): QcFinding {
  return {
    findingId: "f-1",
    severity: "medium",
    title: "Test finding",
    fixAvailable: false,
    autofixEligible: false,
    attribution: { confidence: "unattributed", reason: "unattributed" },
    status: "open",
    ...overrides,
  };
}

describe("resolveAttribution", () => {
  it("attributes a finding to the single child that changed its file", () => {
    const context: QcAttributionContext = {
      changedFilesByChild: {
        "POL-472": ["src/qc/config.ts"],
      },
    };
    const finding = makeFinding({ filePath: "src/qc/config.ts" });
    const attribution = resolveAttribution(finding, context);
    expect(attribution.confidence).toBe("high");
    expect(attribution.reason).toBe("changed-file-owner");
    expect(attribution.childId).toBe("POL-472");
    expect(attribution.filePath).toBe("src/qc/config.ts");
  });

  it("uses commit-line-match when finding commit matches child commit", () => {
    const context: QcAttributionContext = {
      changedFilesByChild: {
        "POL-472": ["src/qc/config.ts"],
      },
      clusterState: {
        schema_version: "1.0",
        cluster_id: "POL-470",
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: { "POL-472": "abc123" },
        tracker_mutations: {},
        blockers: [],
      },
    };
    const finding = makeFinding({ filePath: "src/qc/config.ts", commitSha: "abc123" });
    const attribution = resolveAttribution(finding, context);
    expect(attribution.confidence).toBe("high");
    expect(attribution.reason).toBe("commit-line-match");
    expect(attribution.childId).toBe("POL-472");
  });

  it("flags shared-file when multiple children changed the same file", () => {
    const context: QcAttributionContext = {
      changedFilesByChild: {
        "POL-472": ["src/qc/config.ts"],
        "POL-473": ["src/qc/config.ts"],
      },
    };
    const finding = makeFinding({ filePath: "src/qc/config.ts" });
    const attribution = resolveAttribution(finding, context);
    expect(attribution.confidence).toBe("low");
    expect(attribution.reason).toBe("shared-file");
  });

  it("marks provider-uncertain for an unknown commit sha", () => {
    const context: QcAttributionContext = {
      changedFilesByChild: {
        "POL-472": ["src/qc/config.ts"],
      },
      clusterState: {
        schema_version: "1.0",
        cluster_id: "POL-470",
        state_generation: 1,
        child_states: [],
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: { "POL-472": "abc123" },
        tracker_mutations: {},
        blockers: [],
      },
    };
    const finding = makeFinding({ filePath: "src/qc/config.ts", commitSha: "unknown999" });
    const attribution = resolveAttribution(finding, context);
    expect(attribution.confidence).toBe("low");
    expect(attribution.reason).toBe("provider-uncertain");
  });

  it("marks provider-uncertain when provider confidence is below threshold", () => {
    const context: QcAttributionContext = {
      changedFilesByChild: {
        "POL-472": ["src/qc/config.ts"],
      },
      providerConfidenceThreshold: 0.8,
    };
    const finding = makeFinding({ filePath: "src/qc/config.ts", confidence: 0.4 });
    const attribution = resolveAttribution(finding, context);
    expect(attribution.confidence).toBe("low");
    expect(attribution.reason).toBe("provider-uncertain");
  });

  it("marks unattributed when no file path is given", () => {
    const context: QcAttributionContext = {
      changedFilesByChild: { "POL-472": ["src/qc/config.ts"] },
    };
    const finding = makeFinding({ filePath: undefined });
    const attribution = resolveAttribution(finding, context);
    expect(attribution.confidence).toBe("unattributed");
    expect(attribution.reason).toBe("provider-uncertain");
  });
});

describe("buildChangedFileOwnership", () => {
  it("builds ownership from completed result changed_files", () => {
    const context: QcAttributionContext = {
      completedResults: {
        "POL-472": {
          child_id: "POL-472",
          run_id: "run-1",
          cluster_id: "POL-470",
          status: "done",
          validation: "passed",
          commit: "abc123",
          next_recommended_action: "continue",
          role: "worker",
          provider: "devin",
          skill_name: "polaris-run",
          packet_hash: "hash",
          worker_id: "w1",
          escalation_count: 0,
          heartbeat_count: 1,
          result_artifact_path: "/x",
          packet_path: "/p",
          telemetry_path: "/t",
          user_intervened: null,
          foreman_intervened: null,
          changed_files: ["src/qc/config.ts"],
        },
      },
    };
    const ownership = buildChangedFileOwnership(context);
    expect(ownership["POL-472"]).toEqual(["src/qc/config.ts"]);
  });
});
