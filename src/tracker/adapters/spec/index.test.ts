import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SpecAdapter } from "./index.js";

const FIXTURE_PATH = join(
  process.cwd(),
  "src",
  "tracker",
  "adapters",
  "spec",
  "__fixtures__",
  "sample-spec.md",
);

describe("SpecAdapter", () => {
  it("syncIn parses a markdown fixture into a valid LocalGraph", async () => {
    const graph = await new SpecAdapter().syncIn(FIXTURE_PATH);
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

  it("syncIn sets source.type to 'spec' and source.id to the file path", async () => {
    const graph = await new SpecAdapter().syncIn(FIXTURE_PATH);
    expect(graph.fullGraph.source.type).toBe("spec");
    expect(graph.fullGraph.source.id).toBe(FIXTURE_PATH);
  });

  it("syncIn creates a root node with the objective as the title", async () => {
    const graph = await new SpecAdapter().syncIn(FIXTURE_PATH);
    const clusterId = graph.fullGraph.activeCluster;
    const rootNode = graph.getNode(clusterId);
    expect(rootNode).toBeDefined();
    expect(rootNode?.title).toBe("Deliver a local spec-driven execution graph.");
  });

  it("syncIn child nodes have sessionType 'implement'", async () => {
    const graph = await new SpecAdapter().syncIn(FIXTURE_PATH);
    const child = graph.getNode("spec-child-01");
    expect(child?.sessionType).toBe("implement");
  });

  it("syncIn throws when ## Objective section is missing", async () => {
    const tempDir = join(tmpdir(), `spec-adapter-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const badSpec = join(tempDir, "no-objective.md");
    try {
      writeFileSync(badSpec, "## Children\n- Do something\n");
      await expect(new SpecAdapter().syncIn(badSpec)).rejects.toThrow(
        "missing required section: ## Objective",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("syncIn throws when ## Children section has no items", async () => {
    const tempDir = join(tmpdir(), `spec-adapter-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const badSpec = join(tempDir, "no-children.md");
    try {
      writeFileSync(badSpec, "## Objective\nDo something\n\n## Children\n");
      await expect(new SpecAdapter().syncIn(badSpec)).rejects.toThrow(
        "missing required section content: ## Children",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("syncIn derives cluster ID from the filename slug", async () => {
    const tempDir = join(tmpdir(), `spec-adapter-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const spec = join(tempDir, "my-cool-feature.md");
    try {
      writeFileSync(
        spec,
        "## Objective\nBuild the feature\n\n## Children\n- Step one\n",
      );
      const graph = await new SpecAdapter().syncIn(spec);
      expect(graph.fullGraph.activeCluster).toBe("spec-my-cool-feature");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
