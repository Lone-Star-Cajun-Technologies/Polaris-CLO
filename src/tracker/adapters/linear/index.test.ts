import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinearAdapter } from "./index.js";
import { PolarisConfig } from "../../../config/schema.js";
import { LocalGraph } from "../../local-graph.js";

describe("LinearAdapter", () => {
  let config: PolarisConfig;
  let linearClient: {
    listTeams: ReturnType<typeof vi.fn>;
    listProjects: ReturnType<typeof vi.fn>;
    listIssues: ReturnType<typeof vi.fn>;
    getIssueById: ReturnType<typeof vi.fn>;
    getIssueStateOptions: ReturnType<typeof vi.fn>;
    updateIssueState: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    config = {
      tracker: {
        linear: {
          enabled: true,
          teamId: "mock-team-id",
          projectId: "mock-project-id",
        },
      },
    };

    linearClient = {
      listTeams: vi.fn(),
      listProjects: vi.fn(),
      listIssues: vi.fn(),
      getIssueById: vi.fn(),
      getIssueStateOptions: vi.fn(),
      updateIssueState: vi.fn(),
    };

    linearClient.listTeams.mockResolvedValue([
      { id: "mock-team-id", name: "Mock Team" },
    ]);
    linearClient.listProjects.mockResolvedValue([
      { id: "mock-project-id", name: "Mock Project" },
    ]);
    linearClient.listIssues.mockResolvedValue([
      {
        id: "issue-1",
        title: "Test Issue 1",
        description: "Body of issue 1.",
        state: { id: "status-id-1", name: "Todo" },
        relations: {
          nodes: [
            {
              id: "rel-1",
              type: "blocks",
              issue: { id: "issue-2" },
              relatedIssue: { id: "issue-1" },
            },
          ],
        },
        inverseRelations: { nodes: [] },
        children: { nodes: [] },
      },
      {
        id: "issue-2",
        title: "Test Issue 2",
        description: "Body of issue 2.",
        state: { id: "status-id-2", name: "In Progress" },
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
        children: { nodes: [] },
      },
    ]);

    linearClient.getIssueById.mockResolvedValueOnce({
      id: "root-issue-id",
      identifier: "POL-198",
      title: "Root issue",
      description: "Root issue body text.",
      state: { id: "status-id-3", name: "Todo" },
      relations: {
        nodes: [
          {
            id: "rel-2",
            type: "blocked_by",
            issue: { id: "root-issue-id", identifier: "POL-198", title: "Root issue" },
            relatedIssue: { id: "blocker-id", identifier: "POL-42", title: "Blocking issue" },
          },
          {
            id: "rel-3",
            type: "blocks",
            issue: { id: "root-issue-id", identifier: "POL-198", title: "Root issue" },
            relatedIssue: { id: "blocked-id", identifier: "POL-199", title: "Blocked issue" },
          },
        ],
      },
      inverseRelations: { nodes: [] },
      children: { nodes: [{ id: "child-issue-id", identifier: "POL-200", title: "Child issue" }] },
    });
    linearClient.getIssueById.mockResolvedValue({
      id: "child-issue-id",
      identifier: "POL-200",
      title: "Child issue",
      description: "Child issue body text.",
      state: { id: "status-id-4", name: "In Progress" },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      children: { nodes: [] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws when LINEAR_API_KEY is missing for direct Linear API usage", async () => {
    const originalApiKey = process.env["LINEAR_API_KEY"];
    delete process.env["LINEAR_API_KEY"];
    config.tracker!.linear!.teamId = "mock-team-id";

    try {
      const adapter = new LinearAdapter(config);
      await expect(adapter.syncIn()).rejects.toThrow("LINEAR_API_KEY is required for the 'linear' tracker adapter.");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env["LINEAR_API_KEY"];
      } else {
        process.env["LINEAR_API_KEY"] = originalApiKey;
      }
    }
  });

  it("should return a LocalGraph instance", async () => {
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    expect(graph).toBeInstanceOf(LocalGraph);
  });

  it("should correctly map Linear issues to ExecutionGraphV2 nodes", async () => {
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    const fullGraph = graph.fullGraph;

    expect(fullGraph.nodes["issue-1"]).toEqual({
      id: "issue-1",
      title: "Test Issue 1",
      status: "Todo",
      body: "Body of issue 1.",
    });
    expect(fullGraph.nodes["issue-2"]).toEqual({
      id: "issue-2",
      title: "Test Issue 2",
      status: "In Progress",
      body: "Body of issue 2.",
    });
  });

  it("stores the issue body in the node when description is present", async () => {
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    expect(graph.getNode("issue-1")?.body).toBe("Body of issue 1.");
    expect(graph.getNode("issue-2")?.body).toBe("Body of issue 2.");
  });

  it("omits body from node when description is absent", async () => {
    linearClient.listIssues.mockResolvedValueOnce([
      {
        id: "no-body-issue",
        title: "Issue without body",
        state: { id: "status-id-1", name: "Todo" },
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
        children: { nodes: [] },
      },
    ]);
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    expect(graph.getNode("no-body-issue")?.body).toBeUndefined();
  });

  it("should correctly map Linear issue dependencies", async () => {
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    const fullGraph = graph.fullGraph;

    expect(fullGraph.dependencies["issue-1"]).toEqual(["issue-2"]);
    expect(fullGraph.dependencies["issue-2"]).toBeUndefined();
  });

  it("should create a cluster based on project and team IDs", async () => {
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    const fullGraph = graph.fullGraph;

    const expectedClusterId = "Mock Team-mock-project-id";
    expect(fullGraph.activeCluster).toBe(expectedClusterId);
    expect(fullGraph.clusters[expectedClusterId]).toEqual({
      id: expectedClusterId,
      title: "Linear Project: mock-project-id (Mock Team)",
      children: ["issue-1", "issue-2"],
    });
  });

  it("should throw an error if teamId is not found", async () => {
    config.tracker!.linear!.teamId = "non-existent-team";
    linearClient.listTeams.mockResolvedValueOnce([
      { id: "another-team-id", name: "Another Team" },
    ]);

    const adapter = new LinearAdapter(config, linearClient);
    await expect(adapter.syncIn()).rejects.toThrow(
      "Linear team with ID or name 'non-existent-team' not found."
    );
  });

  it("should throw an error if projectId is not found in team", async () => {
    config.tracker!.linear!.projectId = "non-existent-project";
    linearClient.listProjects.mockResolvedValueOnce([
      { id: "another-project-id", name: "Another Project" },
    ]);

    const adapter = new LinearAdapter(config, linearClient);
    await expect(adapter.syncIn()).rejects.toThrow(
      "Linear project with ID or name 'non-existent-project' not found in team 'Mock Team'."
    );
  });

  it("should warn and fetch all issues if no teamId is specified", async () => {
    config.tracker!.linear!.teamId = undefined;
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    linearClient.listIssues.mockResolvedValueOnce([
      {
        id: "issue-3",
        title: "Global Issue",
        state: { id: "status-id-3", name: "Todo" },
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
        children: { nodes: [] },
      },
    ]);

    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    const fullGraph = graph.fullGraph;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "No Linear teamId specified in config. Fetching all accessible Linear issues. Consider specifying 'teamId' for better scope."
    );
    expect(fullGraph.nodes["issue-3"]).toBeDefined();
    expect(fullGraph.activeCluster).toBe("default");
    expect(fullGraph.clusters["default"].title).toBe("All Linear Issues");
    consoleWarnSpy.mockRestore();
  });

  it("syncs by Linear issue identifier including children and dependency relations", async () => {
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn("POL-198");
    const fullGraph = graph.fullGraph;

    expect(linearClient.getIssueById).toHaveBeenCalledWith("POL-198");
    expect(linearClient.getIssueById).toHaveBeenCalledWith("child-issue-id");
    expect(fullGraph.activeCluster).toBe("POL-198");

    // Root (POL-198) is a context node — it must not appear as a runnable child.
    // Relation targets (POL-42, POL-199) are context/dependency references — also excluded.
    // Only the direct Linear sub-issue (POL-200) is a runnable child.
    expect(fullGraph.clusters["POL-198"].children).toEqual(["POL-200"]);
    expect(fullGraph.clusters["POL-198"].cluster_root).toBe("POL-198");

    // All nodes remain in the graph for dependency/reference purposes.
    expect(fullGraph.nodes["POL-198"]).toEqual({
      id: "POL-198",
      title: "Root issue",
      status: "Todo",
      body: "Root issue body text.",
    });
    expect(fullGraph.nodes["POL-200"]).toEqual({
      id: "POL-200",
      title: "Child issue",
      status: "In Progress",
      body: "Child issue body text.",
    });
    expect(fullGraph.nodes["POL-42"]).toBeDefined();
    expect(fullGraph.nodes["POL-199"]).toBeDefined();

    // Dependency edges are still correctly mapped.
    expect(fullGraph.dependencies["POL-198"]).toEqual(["POL-42"]);
    expect(fullGraph.dependencies["POL-199"]).toEqual(["POL-198"]);
  });

  it("excludes relation-referenced issues from runnable children in single-target mode", async () => {
    // POL-42 (blocks root) and POL-199 (blocked by root) are context/dependency references.
    // They must appear in nodes (graph reference) but must NOT appear in children.
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn("POL-198");
    const fullGraph = graph.fullGraph;

    // Relation targets are in the graph for edge/dependency resolution.
    expect(fullGraph.nodes["POL-42"]).toBeDefined();
    expect(fullGraph.nodes["POL-199"]).toBeDefined();

    // But they must never appear in the runnable children list.
    expect(fullGraph.clusters["POL-198"].children).not.toContain("POL-42");
    expect(fullGraph.clusters["POL-198"].children).not.toContain("POL-199");
    expect(fullGraph.clusters["POL-198"].children).not.toContain("POL-198");
  });

  it("treats the root as a runnable leaf when it has no Linear children", async () => {
    linearClient.getIssueById.mockReset();
    linearClient.getIssueById.mockResolvedValue({
      id: "leaf-issue-id",
      identifier: "POL-300",
      title: "Leaf issue",
      state: { id: "status-id-5", name: "Todo" },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      children: { nodes: [] },
    });
    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn("POL-300");
    const fullGraph = graph.fullGraph;

    // No sub-issues → root itself is the runnable leaf.
    expect(fullGraph.clusters["POL-300"].children).toEqual(["POL-300"]);
    expect(fullGraph.clusters["POL-300"].cluster_root).toBe("POL-300");
  });

  it("ignores unknown relation types safely", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    linearClient.listIssues.mockResolvedValueOnce([
      {
        id: "issue-unknown-rel",
        title: "Issue with unknown relation",
        state: { id: "status-id-1", name: "Todo" },
        relations: {
          nodes: [
            {
              id: "rel-unknown",
              type: "related",
              issue: { id: "issue-unknown-rel" },
              relatedIssue: { id: "issue-other" },
            },
          ],
        },
        inverseRelations: { nodes: [] },
        children: { nodes: [] },
      },
    ]);

    const adapter = new LinearAdapter(config, linearClient);
    const graph = await adapter.syncIn();
    const fullGraph = graph.fullGraph;

    expect(fullGraph.dependencies["issue-unknown-rel"]).toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Linear relation type 'related' is not mapped to dependencies (supported types: blocks, blocked_by, depends_on); ignoring.",
    );
    consoleWarnSpy.mockRestore();
  });

  describe("transitionLifecycleState", () => {
    it("skips when lifecycleState is no_status_change", async () => {
      const adapter = new LinearAdapter(config, linearClient);
      const result = await adapter.transitionLifecycleState("POL-1", "no_status_change");

      expect(result).toEqual({
        applied: false,
        skipped: true,
        skipReason: "Lifecycle state is 'no_status_change', skipping transition",
      });
      expect(linearClient.getIssueStateOptions).not.toHaveBeenCalled();
    });

    it("resolves the target state by type and applies the mutation", async () => {
      linearClient.getIssueStateOptions.mockResolvedValue({
        currentStateId: "state-in-progress",
        states: [
          { id: "state-backlog", name: "Backlog", type: "backlog" },
          { id: "state-in-progress", name: "In Progress", type: "started" },
          { id: "state-done", name: "Done", type: "completed" },
        ],
      });
      linearClient.updateIssueState.mockResolvedValue(true);

      const adapter = new LinearAdapter(config, linearClient);
      const result = await adapter.transitionLifecycleState("POL-1", "done");

      expect(linearClient.updateIssueState).toHaveBeenCalledWith("POL-1", "state-done");
      expect(result).toEqual({ applied: true, skipped: false });
    });

    it("is idempotent when the issue is already in the target state", async () => {
      linearClient.getIssueStateOptions.mockResolvedValue({
        currentStateId: "state-done",
        states: [{ id: "state-done", name: "Done", type: "completed" }],
      });

      const adapter = new LinearAdapter(config, linearClient);
      const result = await adapter.transitionLifecycleState("POL-1", "done");

      expect(linearClient.updateIssueState).not.toHaveBeenCalled();
      expect(result).toEqual({
        applied: false,
        skipped: true,
        skipReason: "Issue is already in target state 'Done'",
      });
    });

    it("skips when no workflow state maps to the target lifecycle state", async () => {
      linearClient.getIssueStateOptions.mockResolvedValue({
        currentStateId: "state-backlog",
        states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
      });

      const adapter = new LinearAdapter(config, linearClient);
      const result = await adapter.transitionLifecycleState("POL-1", "done");

      expect(result).toEqual({
        applied: false,
        skipped: true,
        skipReason:
          "No Linear workflow state on this issue's team maps to lifecycle state 'done'",
      });
    });

    it("skips when the issue is not found", async () => {
      linearClient.getIssueStateOptions.mockResolvedValue(null);

      const adapter = new LinearAdapter(config, linearClient);
      const result = await adapter.transitionLifecycleState("POL-1", "done");

      expect(result).toEqual({
        applied: false,
        skipped: true,
        skipReason: "Linear issue 'POL-1' not found",
      });
    });

    it("returns an error result when the mutation reports failure", async () => {
      linearClient.getIssueStateOptions.mockResolvedValue({
        currentStateId: "state-in-progress",
        states: [
          { id: "state-in-progress", name: "In Progress", type: "started" },
          { id: "state-done", name: "Done", type: "completed" },
        ],
      });
      linearClient.updateIssueState.mockResolvedValue(false);

      const adapter = new LinearAdapter(config, linearClient);
      const result = await adapter.transitionLifecycleState("POL-1", "done");

      expect(result).toEqual({
        applied: false,
        skipped: false,
        error: "Linear issueUpdate mutation for POL-1 returned success: false",
      });
    });

    it("returns an error result when fetching state options throws", async () => {
      linearClient.getIssueStateOptions.mockRejectedValue(new Error("network down"));

      const adapter = new LinearAdapter(config, linearClient);
      const result = await adapter.transitionLifecycleState("POL-1", "done");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.error).toContain("network down");
    });
  });
});
