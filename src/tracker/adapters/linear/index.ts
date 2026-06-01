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
  identifier?: string;
  title: string;
  description?: string;
  state?: { id: string; name: string };
  parent?: LinearIssueRef | null;
  children?: LinearConnection<LinearIssueRef>;
  relations?: LinearConnection<LinearIssueRelation>;
  inverseRelations?: LinearConnection<LinearIssueRelation>;
}

interface LinearIssueRef {
  id: string;
  identifier?: string;
  title?: string;
  description?: string;
  state?: { id: string; name: string };
}

interface LinearConnection<T> {
  nodes: T[];
}

interface LinearIssueRelation {
  id: string;
  type?: string;
  issue?: LinearIssueRef;
  relatedIssue?: LinearIssueRef;
}

interface LinearApiClient {
  listTeams(): Promise<LinearTeam[]>;
  listProjects(teamId: string): Promise<LinearProject[]>;
  listIssues(filters: { teamId?: string; projectId?: string }): Promise<LinearIssue[]>;
  getIssueById(id: string): Promise<LinearIssue | null>;
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
            const responseBody = Buffer.concat(chunks).toString("utf-8");
            if ((res.statusCode ?? 0) >= 400) {
              reject(
                new Error(
                  `Linear API returned ${res.statusCode}: ${responseBody || "<empty response body>"}`,
                ),
              );
              return;
            }
            resolve(responseBody);
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
              identifier
              title
              description
              state { id name }
              children {
                nodes {
                  id
                  identifier
                  title
                  description
                  state { id name }
                }
              }
              relations {
                nodes {
                  id
                  type
                  issue {
                    id
                    identifier
                    title
                    state { id name }
                  }
                  relatedIssue {
                    id
                    identifier
                    title
                    state { id name }
                  }
                }
              }
              inverseRelations {
                nodes {
                  id
                  type
                  issue {
                    id
                    identifier
                    title
                    state { id name }
                  }
                  relatedIssue {
                    id
                    identifier
                    title
                    state { id name }
                  }
                }
              }
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

  async getIssueById(id: string): Promise<LinearIssue | null> {
    const data = await this.graphql<{ issue: LinearIssue | null }>(
      `
        query PolarisLinearIssueById($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            state { id name }
            children {
              nodes {
                id
                identifier
                title
                state { id name }
              }
            }
            relations {
              nodes {
              id
              type
              issue {
                id
                identifier
                title
                state { id name }
              }
              relatedIssue {
                id
                identifier
                title
                state { id name }
              }
              }
            }
            inverseRelations {
              nodes {
              id
              type
              issue {
                id
                identifier
                title
                state { id name }
              }
              relatedIssue {
                id
                identifier
                title
                state { id name }
              }
              }
            }
          }
        }
      `,
      { id },
    );
    return data.issue;
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

  private issueNodeId(issue: Pick<LinearIssueRef, "id" | "identifier">): string {
    return issue.identifier ?? issue.id;
  }

  private addDependency(dependencies: Record<string, string[]>, nodeId: string, dependsOnNodeId: string): void {
    if (!dependencies[nodeId]) {
      dependencies[nodeId] = [];
    }
    if (!dependencies[nodeId].includes(dependsOnNodeId)) {
      dependencies[nodeId].push(dependsOnNodeId);
    }
  }

  private upsertNode(nodes: Record<string, ExecutionNode>, issue: LinearIssueRef): string {
    const nodeId = this.issueNodeId(issue);
    const statusName = issue.state?.name ?? issue.state?.id ?? "Unknown";
    if (!nodes[nodeId]) {
      nodes[nodeId] = {
        id: nodeId,
        title: issue.title ?? issue.identifier ?? issue.id,
        status: statusName,
        ...(issue.description ? { body: issue.description } : {}),
      };
      return nodeId;
    }

    if (
      issue.title &&
      (!nodes[nodeId].title ||
        nodes[nodeId].title === issue.identifier ||
        nodes[nodeId].title === issue.id)
    ) {
      nodes[nodeId].title = issue.title;
    }
    if ((nodes[nodeId].status === "Unknown" || !nodes[nodeId].status) && issue.state) {
      nodes[nodeId].status = statusName;
    }
    if (issue.description && !nodes[nodeId].body) {
      nodes[nodeId].body = issue.description;
    }
    return nodeId;
  }

  private relationDependency(
    relation: LinearIssueRelation,
    issueNodeId: string,
  ): { fromId: string; dependsOnId: string } | null {
    if (!relation.issue || !relation.relatedIssue || !relation.type) {
      return null;
    }

    const relationType = this.normalizeRelationType(relation.type);
    const sourceNodeId = this.issueNodeId(relation.issue);
    const relatedNodeId = this.issueNodeId(relation.relatedIssue);

    if (sourceNodeId !== issueNodeId && relatedNodeId !== issueNodeId) {
      return null;
    }

    if (relationType === "BLOCKS") {
      return {
        fromId: relatedNodeId,
        dependsOnId: sourceNodeId,
      };
    }

    if (relationType === "BLOCKED_BY" || relationType === "DEPENDS_ON") {
      return {
        fromId: sourceNodeId,
        dependsOnId: relatedNodeId,
      };
    }

    console.warn(
      `Linear relation type '${relation.type}' is not mapped to dependencies (supported types: blocks, blocked_by, depends_on); ignoring.`,
    );
    return null;
  }

  private normalizeRelationType(type: string): string {
    return type.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  }

  private mapIssueRelations(
    issue: LinearIssue,
    nodes: Record<string, ExecutionNode>,
    dependencies: Record<string, string[]>,
  ): void {
    const issueNodeId = this.upsertNode(nodes, issue);

    const relationNodes = [
      ...(issue.relations?.nodes ?? []),
      ...(issue.inverseRelations?.nodes ?? []),
    ];
    for (const relation of relationNodes) {
      if (relation.issue) {
        this.upsertNode(nodes, relation.issue);
      }
      if (relation.relatedIssue) {
        this.upsertNode(nodes, relation.relatedIssue);
      }
      const dependency = this.relationDependency(relation, issueNodeId);
      if (!dependency) {
        continue;
      }
      this.addDependency(dependencies, dependency.fromId, dependency.dependsOnId);
    }

    for (const childIssue of issue.children?.nodes ?? []) {
      this.upsertNode(nodes, childIssue);
    }
  }

  private async collectIssueAndChildren(issueId: string): Promise<LinearIssue[]> {
    const rootIssue = await this.linearClient.getIssueById(issueId);
    if (!rootIssue) {
      throw new Error(`Linear issue ID '${issueId}' not found.`);
    }

    const issueMap = new Map<string, LinearIssue>([[rootIssue.id, rootIssue]]);
    const pendingChildIds: string[] = (rootIssue.children?.nodes ?? []).map((child) => child.id);
    const fetchedChildIds = new Set<string>();
    let queueIndex = 0;

    while (queueIndex < pendingChildIds.length) {
      const childId = pendingChildIds[queueIndex];
      queueIndex += 1;
      if (!childId || fetchedChildIds.has(childId)) {
        continue;
      }

      fetchedChildIds.add(childId);
      const childIssue = await this.linearClient.getIssueById(childId);
      if (!childIssue) {
        continue;
      }

      issueMap.set(childIssue.id, childIssue);
      for (const grandchild of childIssue.children?.nodes ?? []) {
        if (!fetchedChildIds.has(grandchild.id)) {
          pendingChildIds.push(grandchild.id);
        }
      }
    }

    return Array.from(issueMap.values());
  }

  /**
   * Synchronizes issues from Linear into a LocalGraph format.
   * @returns A promise that resolves to a LocalGraph instance.
   */
  async syncIn(issueIdentifier?: string): Promise<LocalGraph> {
    const linearConfig = this.config.tracker?.linear;
    if (!linearConfig || !linearConfig.enabled) {
      throw new Error("Linear tracker not enabled in config.");
    }

    const teamId = linearConfig.teamId;
    const projectId = linearConfig.projectId;

    let issues: LinearIssue[] = [];
    let teamName: string | undefined;
    let resolvedTeamId: string | undefined;
    let sourceId: string;
    let sourceDoc: string;
    let activeClusterId: string;
    let clusterTitle: string;

    if (issueIdentifier) {
      issues = await this.collectIssueAndChildren(issueIdentifier);
      sourceId = issueIdentifier;
      sourceDoc = `Synchronized from Linear issue identifier: ${issueIdentifier}`;
      activeClusterId = issueIdentifier;
      clusterTitle = `Linear Issue: ${issueIdentifier}`;
    } else if (teamId) {
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
      sourceId = resolvedTeamId ?? teamId;
      sourceDoc = `Synchronized from Linear team: ${teamName}${projectId ? `, project: ${projectId}` : ''}`;
      if (projectId && teamName) {
        activeClusterId = `${teamName}-${projectId}`;
        clusterTitle = `Linear Project: ${projectId} (${teamName})`;
      } else {
        activeClusterId = teamName;
        clusterTitle = `Linear Team: ${teamName}`;
      }
    } else {
      console.warn("No Linear teamId specified in config. Fetching all accessible Linear issues. Consider specifying 'teamId' for better scope.");
      issues = await this.linearClient.listIssues({});
      sourceId = "all-linear-issues";
      sourceDoc = "Synchronized from Linear team: all";
      activeClusterId = "default";
      clusterTitle = "All Linear Issues";
    }

    const nodes: Record<string, ExecutionNode> = {};
    const dependencies: Record<string, string[]> = {};
    const clusters: Record<string, ExecutionCluster> = {};
    clusters[activeClusterId] = {
      id: activeClusterId,
      title: clusterTitle,
      children: [],
    };
    const clusterChildren = new Set<string>();

    // In single-target mode the first issue is the cluster root — a context node,
    // not a dispatch target. Only its fetched descendants are runnable children.
    // Relation-referenced issues go into the nodes map for graph reference but
    // must not be promoted to runnable children.
    const clusterRootNodeId =
      issueIdentifier && issues.length > 0 ? this.issueNodeId(issues[0]) : null;

    for (const issue of issues) {
      this.mapIssueRelations(issue, nodes, dependencies);

      if (clusterRootNodeId !== null) {
        // Single-target mode: every fetched descendant except the root is runnable.
        const nodeId = this.issueNodeId(issue);
        if (nodeId !== clusterRootNodeId) {
          clusterChildren.add(nodeId);
        }
        // Relation targets are added to nodes by mapIssueRelations above but
        // are intentionally excluded from runnable children here.
      } else {
        // Team/project mode: all fetched issues plus their relations are runnable.
        clusterChildren.add(this.issueNodeId(issue));
        for (const relation of issue.relations?.nodes ?? []) {
          if (relation.issue) {
            clusterChildren.add(this.issueNodeId(relation.issue));
          }
          if (relation.relatedIssue) {
            clusterChildren.add(this.issueNodeId(relation.relatedIssue));
          }
        }
        for (const relation of issue.inverseRelations?.nodes ?? []) {
          if (relation.issue) {
            clusterChildren.add(this.issueNodeId(relation.issue));
          }
          if (relation.relatedIssue) {
            clusterChildren.add(this.issueNodeId(relation.relatedIssue));
          }
        }
        for (const childIssue of issue.children?.nodes ?? []) {
          clusterChildren.add(this.issueNodeId(childIssue));
        }
      }
    }

    // Single-target leaf: root has no implementation children → root is itself runnable.
    if (clusterRootNodeId !== null && clusterChildren.size === 0) {
      clusterChildren.add(clusterRootNodeId);
    }

    clusters[activeClusterId] = {
      ...clusters[activeClusterId],
      children: Array.from(clusterChildren),
      ...(clusterRootNodeId !== null ? { cluster_root: clusterRootNodeId } : {}),
    };

    const graph: ExecutionGraphV2 = {
      schemaVersion: "v2",
      source: {
        id: sourceId,
        type: "Linear",
        analysis: {
          id: "initial-sync",
          doc: sourceDoc,
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
