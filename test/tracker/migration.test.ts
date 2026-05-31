import { describe, it, expect } from "vitest";
import { migrateV1toV2 } from "../../src/tracker/migration.js";
import type { ExecutionGraphV1 } from "../../src/tracker/types.js";

const v1Fixture: ExecutionGraphV1 = {
  source_id: "POL-105",
  analyze_source_id: "POL-104",
  source_type: "linear",
  created_at: "2026-05-26T14:01:00.000Z",
  analysis_doc: null,
  clusters: [
    {
      cluster_id: "cluster-01",
      description: "Tracks A and B: Issue hierarchy doctrine and tooling (POL-106 → POL-108, POL-109; includes POL-107, POL-110, POL-111, POL-112)",
      children: [
        {
          id: "POL-106",
          title: "IMPLEMENT: Write issue-hierarchy-doctrine.md and migration guide",
          session_type: "implement",
          blockedBy: [],
        },
        {
          id: "POL-107",
          title: "IMPLEMENT: Write ephemeral-execution-architecture.md (Claude, Codex, manual fallback, test plan)",
          session_type: "implement",
          blockedBy: [],
        },
        {
          id: "POL-108",
          title: "IMPLEMENT: Update polaris-analyze step 05 to create separate IMPLEMENT parent issue",
          session_type: "implement",
          blockedBy: ["POL-106"],
        },
      ],
    },
  ],
};

describe("migrateV1toV2", () => {
  it("should migrate a v1 graph to a v2 graph", () => {
    const v2Graph = migrateV1toV2(v1Fixture);

    expect(v2Graph.schemaVersion).toBe("v2");
    expect(v2Graph.source.id).toBe("POL-105");
    expect(v2Graph.source.type).toBe("linear");
    expect(v2Graph.source.analysis?.id).toBe("POL-104");
    expect(v2Graph.activeCluster).toBe("cluster-01");
    
    expect(Object.keys(v2Graph.nodes)).toHaveLength(3);
    expect(v2Graph.nodes["POL-106"].title).toBe("IMPLEMENT: Write issue-hierarchy-doctrine.md and migration guide");
    expect(v2Graph.nodes["POL-106"].status).toBe("Todo");
    expect(v2Graph.nodes["POL-108"].sessionType).toBe("implement");

    expect(Object.keys(v2Graph.dependencies)).toHaveLength(1);
    expect(v2Graph.dependencies["POL-108"]).toEqual(["POL-106"]);
    
    expect(Object.keys(v2Graph.clusters)).toHaveLength(1);
    expect(v2Graph.clusters["cluster-01"].children).toEqual(["POL-106", "POL-107", "POL-108"]);
  });
});
