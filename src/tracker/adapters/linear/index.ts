import { LocalGraph } from "../../local-graph.js";
import { PolarisConfig } from "../../../config/schema.js";
import { mcp_linear_list_issues, mcp_linear_get_issue_status, mcp_linear_list_teams, mcp_linear_list_projects } from "@tool-server/linear";
import { ExecutionGraphV2, ExecutionNode, ExecutionCluster } from "../../types.js";
import { executionGraphV2Schema } from "../../schema.js";

/**
 * Implements the Linear direct adapter for synchronizing issues.
 */
export class LinearAdapter {
  private config: PolarisConfig;

  constructor(config: PolarisConfig) {
    this.config = config;
  }

  /**
   * Synchronizes issues from Linear into a LocalGraph format.
   * @returns A promise that resolves to a LocalGraph instance.
   */
  async syncIn(): Promise<LocalGraph> {
    const linearConfig = this.config.tracker?.linear;
    if (!linearConfig || !linearConfig.enabled) {
      throw new Error("Linear tracker not enabled in config.");
    }

    const teamId = linearConfig.teamId;
    const projectId = linearConfig.projectId;

    let issues: any[] = [];
    let allTeamStatuses: any[] = [];
    let teamName: string | undefined;

    if (teamId) {
      const teamsResponse = await mcp_linear_list_teams({});
      const team = teamsResponse.find(t => t.id === teamId || t.name === teamId);
      if (!team) {
        throw new Error(`Linear team with ID or name '${teamId}' not found.`);
      }
      teamName = team.name;
      allTeamStatuses = await mcp_linear_list_issue_statuses({ team: team.id });
      
      const listIssuesArgs: { team: string; project?: string; } = { team: team.id };
      if (projectId) {
        const projectsResponse = await mcp_linear_list_projects({ team: team.id });
        const project = projectsResponse.find(p => p.id === projectId || p.name === projectId);
        if (!project) {
          throw new Error(`Linear project with ID or name '${projectId}' not found in team '${team.name}'.`);
        }
        listIssuesArgs.project = project.id;
      }

      issues = await mcp_linear_list_issues(listIssuesArgs);
    } else {
      // If no teamId is specified, fetch all issues accessible to the current user.
      // This might return a lot of issues, so a warning is appropriate.
      console.warn("No Linear teamId specified in config. Fetching all accessible Linear issues. Consider specifying 'teamId' for better scope.");
      issues = await mcp_linear_list_issues({});
    }

    const nodes: Record<string, ExecutionNode> = {};
    const dependencies: Record<string, string[]> = {};
    const clusters: Record<string, ExecutionCluster> = {};
    let activeClusterId: string = "default"; // Default cluster ID

    // Create a default cluster or use project ID as cluster ID
    if (projectId && teamName) {
      activeClusterId = `${teamName}-${projectId}`;
      clusters[activeClusterId] = {
        id: activeClusterId,
        title: `Linear Project: ${projectId} (${teamName})`,
        children: [],
      };
    } else if (teamName) {
      activeClusterId = teamName;
      clusters[activeClusterId] = {
        id: activeClusterId,
        title: `Linear Team: ${teamName}`,
        children: [],
      };
    } else {
      clusters[activeClusterId] = {
        id: activeClusterId,
        title: "All Linear Issues",
        children: [],
      };
    }

    for (const issue of issues) {
      const statusName = allTeamStatuses.find(s => s.id === issue.status)?.name || issue.status;
      
      nodes[issue.id] = {
        id: issue.id,
        title: issue.title,
        status: statusName,
        // sessionType can be inferred later or set based on other Linear fields
        // For now, it's optional in ExecutionNode, so we can omit it.
      };
      
      // Add issue to the active cluster
      clusters[activeClusterId].children.push(issue.id);

      // Populate dependencies
      const issueDependencies: string[] = [];
      if (issue.blockedBy) {
        issue.blockedBy.forEach((blockerId: string) => {
          issueDependencies.push(blockerId);
        });
      }
      // Linear also has `blocks` field, which means this issue is blocking others.
      // For `dependencies`, we only care about what *this* issue is blocked by.
      if (issueDependencies.length > 0) {
        dependencies[issue.id] = issueDependencies;
      }
    }

    const graph: ExecutionGraphV2 = {
      schemaVersion: "v2",
      source: {
        id: teamId || "all-linear-issues",
        type: "Linear",
        analysis: {
          id: "initial-sync",
          doc: `Synchronized from Linear team: ${teamName || 'all'}${projectId ? `, project: ${projectId}` : ''}`,
        },
      },
      nodes: nodes,
      dependencies: dependencies,
      clusters: clusters,
      activeCluster: activeClusterId,
    };

    const validatedGraph = executionGraphV2Schema.parse(graph);
    return new LocalGraph(validatedGraph);
  }

  /**
   * Synchronizes local changes back to Linear.
   * This includes status updates, comments, and link mutations.
   */
  async syncOut(): Promise<void> {
    console.log("LinearAdapter: syncOut not yet fully implemented.");
    // TODO: Implement export/apply behavior for queued status/comment/link mutations.
    // This will involve using mcp_linear_save_issue and mcp_linear_save_comment.
  }
}
