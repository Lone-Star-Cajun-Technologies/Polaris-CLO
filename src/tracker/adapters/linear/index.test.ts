import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinearAdapter } from "./index.js";
import { PolarisConfig } from "../../../config/schema.js";
import { LocalGraph } from "../../local-graph.js";

// Mock the @tool-server/linear module
vi.mock("@tool-server/linear", () => ({
  mcp_linear_list_teams: vi.fn(),
  mcp_linear_list_projects: vi.fn(),
  mcp_linear_list_issues: vi.fn(),
  mcp_linear_get_issue_status: vi.fn(),
}));

import {
  mcp_linear_list_teams,
  mcp_linear_list_projects,
  mcp_linear_list_issues,
  mcp_linear_get_issue_status,
} from "@tool-server/linear";

const mock_mcp_linear_list_teams = vi.mocked(mcp_linear_list_teams);
const mock_mcp_linear_list_projects = vi.mocked(mcp_linear_list_projects);
const mock_mcp_linear_list_issues = vi.mocked(mcp_linear_list_issues);
const mock_mcp_linear_get_issue_status = vi.mocked(mcp_linear_get_issue_status);

describe("LinearAdapter", () => {
  let config: PolarisConfig;

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

    mock_mcp_linear_list_teams.mockResolvedValue([
      { id: "mock-team-id", name: "Mock Team" },
    ]);
    mock_mcp_linear_list_projects.mockResolvedValue([
      { id: "mock-project-id", name: "Mock Project" },
    ]);
    mock_mcp_linear_list_issues.mockResolvedValue([
      {
        id: "issue-1",
        title: "Test Issue 1",
        status: "status-id-1",
        blockedBy: ["issue-2"],
      },
      {
        id: "issue-2",
        title: "Test Issue 2",
        status: "status-id-2",
        blockedBy: [],
      },
    ]);
    mock_mcp_linear_get_issue_status.mockImplementation(({ team }: { team: string }) => {
      if (team === "mock-team-id") {
        return Promise.resolve([
          { id: "status-id-1", name: "Todo" },
          { id: "status-id-2", name: "In Progress" },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should return a LocalGraph instance", async () => {
    const adapter = new LinearAdapter(config);
    const graph = await adapter.syncIn();
    expect(graph).toBeInstanceOf(LocalGraph);
  });

  it("should correctly map Linear issues to ExecutionGraphV2 nodes", async () => {
    const adapter = new LinearAdapter(config);
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
    const adapter = new LinearAdapter(config);
    const graph = await adapter.syncIn();
    const fullGraph = graph.fullGraph;

    expect(fullGraph.dependencies["issue-1"]).toEqual(["issue-2"]);
    expect(fullGraph.dependencies["issue-2"]).toBeUndefined();
  });

  it("should create a cluster based on project and team IDs", async () => {
    const adapter = new LinearAdapter(config);
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
    mock_mcp_linear_list_teams.mockResolvedValueOnce([
      { id: "another-team-id", name: "Another Team" },
    ]);

    const adapter = new LinearAdapter(config);
    await expect(adapter.syncIn()).rejects.toThrow(
      "Linear team with ID or name 'non-existent-team' not found."
    );
  });

  it("should throw an error if projectId is not found in team", async () => {
    config.tracker!.linear!.projectId = "non-existent-project";
    mock_mcp_linear_list_projects.mockResolvedValueOnce([
      { id: "another-project-id", name: "Another Project" },
    ]);

    const adapter = new LinearAdapter(config);
    await expect(adapter.syncIn()).rejects.toThrow(
      "Linear project with ID or name 'non-existent-project' not found in team 'Mock Team'."
    );
  });

  it("should warn and fetch all issues if no teamId is specified", async () => {
    config.tracker!.linear!.teamId = undefined;
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mock_mcp_linear_list_issues.mockResolvedValueOnce([
      {
        id: "issue-3",
        title: "Global Issue",
        status: "status-id-3",
        blockedBy: [],
      },
    ]);

    const adapter = new LinearAdapter(config);
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
});
