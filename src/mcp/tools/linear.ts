import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { mcp_linear_list_issues, mcp_linear_save_issue } from "@tool-server/linear";

// Handler for listing Linear issues
export async function handleLinearListIssues(
  args: {
    team?: string;
    project?: string;
    assignee?: string;
    query?: string;
  }
) {
  try {
    const issues = await mcp_linear_list_issues({
      team: args.team,
      project: args.project,
      assignee: args.assignee,
      query: args.query,
    });
    return { ok: true, data: issues };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Handler for creating/updating Linear issues
export async function handleLinearSaveIssue(args: {
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
}) {
  try {
    const issue = await mcp_linear_save_issue(args);
    return { ok: true, data: issue };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const LINEAR_TOOLS: Tool[] = [
  {
    name: "linear_list_issues",
    description: "List issues in Linear, with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "Filter by team name or ID" },
        project: { type: "string", description: "Filter by project name, ID, or slug" },
        assignee: { type: "string", description: "Filter by assignee (user ID, name, email, or 'me')" },
        query: { type: "string", description: "Search issue title or description" },
      },
    },
  },
  {
    name: "linear_save_issue",
    description: "Create or update a Linear issue.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Issue ID for updating an existing issue" },
        title: { type: "string", description: "Issue title (required when creating)" },
        team: { type: "string", description: "Team name or ID (required when creating)" },
        description: { type: "string", description: "Issue description as Markdown" },
        project: { type: "string", description: "Project name, ID, or slug" },
        assignee: { type: "string", description: "User ID, name, email, or 'me'" },
        status: { type: "string", description: "State type, name, or ID" },
        priority: { type: "number", description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low" },
        labels: { type: "array", items: { type: "string" }, description: "Label names or IDs" },
        parentId: { type: "string", description: "Parent issue ID" },
        blockedBy: { type: "array", items: { type: "string" }, description: "Issue IDs blocking this" },
        blocks: { type: "array", items: { type: "string" }, description: "Issue IDs this blocks" },
        relatedTo: { type: "array", items: { type: "string" }, description: "Related issue IDs" },
        dueDate: { type: "string", format: "date", description: "Due date (ISO format)" },
      },
      required: [],
    },
  },
];
