/**
 * Ambient type declarations for the @tool-server/linear MCP tool server.
 *
 * These functions are provided by the Linear MCP tool server at runtime.
 * They are not available as an npm package; this file exists solely to
 * satisfy TypeScript's module resolution during compilation.
 */
declare module "@tool-server/linear" {
  export interface LinearTeam {
    id: string;
    name: string;
    [key: string]: unknown;
  }

  export interface LinearProject {
    id: string;
    name: string;
    [key: string]: unknown;
  }

  export interface LinearIssueStatus {
    id: string;
    name: string;
    [key: string]: unknown;
  }

  export interface LinearIssue {
    id: string;
    title: string;
    description?: string;
    status?: string;
    team?: string;
    updatedAt?: string;
    blockedBy?: string[];
    [key: string]: unknown;
  }

  export function mcp_linear_list_teams(args: Record<string, unknown>): Promise<LinearTeam[]>;
  export function mcp_linear_list_projects(args: { team: string }): Promise<LinearProject[]>;
  export function mcp_linear_get_issue_status(args: { team: string }): Promise<LinearIssueStatus[]>;
  export function mcp_linear_list_issues(args: {
    team?: string;
    project?: string;
    assignee?: string;
    query?: string;
  }): Promise<LinearIssue[]>;
  export function mcp_linear_save_issue(args: {
    id?: string;
    title?: string;
    team?: string;
    description?: string;
    project?: string;
    assignee?: string;
    status?: string;
    priority?: number;
    labels?: string[];
    parentId?: string;
    blockedBy?: string[];
    blocks?: string[];
    relatedTo?: string[];
    dueDate?: string;
    [key: string]: unknown;
  }): Promise<LinearIssue>;
  export function mcp_linear_get_issue(args: { id: string }): Promise<LinearIssue>;
}
