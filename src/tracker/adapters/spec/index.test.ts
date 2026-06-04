import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { SpecAdapter } from "./index.js";

describe("SpecAdapter", () => {
  it("syncIn parses a markdown fixture into a valid LocalGraph", async () => {
    const fixturePath = join(
      process.cwd(),
      "src",
      "tracker",
      "adapters",
      "spec",
      "__fixtures__",
      "sample-spec.md",
    );
    const graph = await new SpecAdapter().syncIn(fixturePath);
    const full = graph.fullGraph;
    const active = graph.getActiveCluster();

    expect(full.source.type).toBe("spec");
    expect(full.activeCluster).toBe("spec-sample-spec");
    expect(active.children).toEqual(["spec-child-01", "spec-child-02"]);
    expect(full.nodes["spec-child-01"]?.title).toBe("Parse markdown sections");
    expect(full.nodes["spec-child-02"]?.title).toBe("Wire CLI commands");
    expect(full.nodes["spec-child-01"]?.body).toContain("## Scope");
    expect(full.nodes["spec-child-01"]?.body).toContain("## Validation");
  });
});
