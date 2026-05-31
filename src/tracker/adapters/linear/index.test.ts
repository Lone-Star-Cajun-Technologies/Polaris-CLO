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
    });
    expect(fullGraph.nodes["issue-2"]).toEqual({
      id: "issue-2",
      title: "Test Issue 2",
      status: "In Progress",
    });
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
    expect(fullGraph.clusters["POL-198"].children.slice().sort()).toEqual(
      ["POL-198", "POL-199", "POL-200", "POL-42"].sort(),
    );
    expect(fullGraph.nodes["POL-198"]).toEqual({
      id: "POL-198",
      title: "Root issue",
      status: "Todo",
    });
    expect(fullGraph.nodes["POL-200"]).toEqual({
      id: "POL-200",
      title: "Child issue",
      status: "In Progress",
    });
    expect(fullGraph.dependencies["POL-198"]).toEqual(["POL-42"]);
    expect(fullGraph.dependencies["POL-199"]).toEqual(["POL-198"]);
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
});
