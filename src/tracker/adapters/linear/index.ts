import { LocalGraph } from "../../local-graph.js";
import { PolarisConfig } from "../../../config/schema.js";
import { ExecutionGraphV2, ExecutionNode, ExecutionCluster } from "../../types.js";
import { executionGraphV2Schema } from "../../schema.js";
import { request } from "node:https";

interface LinearTeam {
  id: string;
  name: string;
}

interface LinearProject {
  id: string;
  name: string;
}

interface LinearIssue {
  id: string;
  title: string;
  state?: { id: string; name: string };
  blockedBy?: Array<{ id: string }>;
}

interface LinearApiClient {
  listTeams(): Promise<LinearTeam[]>;
  listProjects(teamId: string): Promise<LinearProject[]>;
  listIssues(filters: { teamId?: string; projectId?: string }): Promise<LinearIssue[]>;
}

class LinearGraphqlClient implements LinearApiClient {
  constructor(private readonly apiKey: string | undefined) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) {
      throw new Error("LINEAR_API_KEY is required for the 'linear' tracker adapter.");
    }

    const payload = JSON.stringify({ query, variables });
    const raw = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: "api.linear.app",
          path: "/graphql",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: this.apiKey,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`Linear API returned ${res.statusCode}`));
              return;
            }
            resolve(Buffer.concat(chunks).toString("utf-8"));
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    const parsed = JSON.parse(raw) as { data?: T; errors?: unknown[] };
    if (parsed.errors && parsed.errors.length > 0) {
      throw new Error(`Linear API GraphQL errors: ${JSON.stringify(parsed.errors)}`);
    }
    if (!parsed.data) {
      throw new Error("Linear API returned no data.");
    }
    return parsed.data;
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(
      "query PolarisLinearTeams { teams(first: 250) { nodes { id name } } }",
      {},
    );
    return data.teams.nodes;
  }

  async listProjects(teamId: string): Promise<LinearProject[]> {
    const data = await this.graphql<{ projects: { nodes: LinearProject[] } }>(
      `
        query PolarisLinearProjects($teamId: String!) {
          projects(filter: { teams: { some: { id: { eq: $teamId } } } }, first: 250) {
            nodes { id name }
          }
        }
      `,
      { teamId },
    );
    return data.projects.nodes;
  }

  async listIssues(filters: { teamId?: string; projectId?: string }): Promise<LinearIssue[]> {
    const data = await this.graphql<{ issues: { nodes: LinearIssue[] } }>(
      `
        query PolarisLinearIssues($teamId: String, $projectId: String) {
          issues(
            first: 250
            filter: {
              team: { id: { eq: $teamId } }
              project: { id: { eq: $projectId } }
            }
          ) {
            nodes {
              id
              title
              state { id name }
              blockedBy { id }
            }
          }
        }
      `,
      {
        teamId: filters.teamId ?? null,
        projectId: filters.projectId ?? null,
      },
    );
    return data.issues.nodes;
  }
}

/**
 * Implements the Linear direct adapter for synchronizing issues.
 */
export class LinearAdapter {
  private config: PolarisConfig;
  private linearClient: LinearApiClient;

  constructor(config: PolarisConfig, linearClient?: LinearApiClient) {
    this.config = config;
    this.linearClient = linearClient ?? new LinearGraphqlClient(process.env["LINEAR_API_KEY"]);
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

    let issues: LinearIssue[] = [];
    let teamName: string | undefined;
    let resolvedTeamId: string | undefined;

    if (teamId) {
      const teamsResponse = await this.linearClient.listTeams();
      const team = teamsResponse.find(t => t.id === teamId || t.name === teamId);
      if (!team) {
        throw new Error(`Linear team with ID or name '${teamId}' not found.`);
      }
      teamName = team.name;
      resolvedTeamId = team.id;
      
      const listIssuesArgs: { teamId: string; projectId?: string; } = { teamId: team.id };
      if (projectId) {
        const projectsResponse = await this.linearClient.listProjects(team.id);
        const project = projectsResponse.find(p => p.id === projectId || p.name === projectId);
        if (!project) {
          throw new Error(`Linear project with ID or name '${projectId}' not found in team '${team.name}'.`);
        }
        listIssuesArgs.projectId = project.id;
      }

      issues = await this.linearClient.listIssues(listIssuesArgs);
    } else {
      // If no teamId is specified, fetch all issues accessible to the current user.
      // This might return a lot of issues, so a warning is appropriate.
      console.warn("No Linear teamId specified in config. Fetching all accessible Linear issues. Consider specifying 'teamId' for better scope.");
      issues = await this.linearClient.listIssues({});
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
      const statusName = issue.state?.name ?? issue.state?.id ?? "Unknown";
      
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
        issue.blockedBy.forEach((blocker) => {
          issueDependencies.push(blocker.id);
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
        id: resolvedTeamId ?? teamId ?? "all-linear-issues",
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
    return LocalGraph.fromGraph(validatedGraph);
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
