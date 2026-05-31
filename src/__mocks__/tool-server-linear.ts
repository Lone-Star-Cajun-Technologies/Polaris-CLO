/**
 * Stub for @tool-server/linear used in test environments.
 * The real module is an MCP runtime tool server — not an npm package.
 * Tests that need specific behaviour should override with vi.mock().
 */
export const mcp_linear_list_teams = async (..._args: unknown[]) => [];
export const mcp_linear_list_projects = async (..._args: unknown[]) => [];
export const mcp_linear_list_issues = async (..._args: unknown[]) => [];
export const mcp_linear_get_issue_status = async (..._args: unknown[]) => [];
export const mcp_linear_get_issue = async (..._args: unknown[]) => ({
  id: 'stub-issue',
  title: 'Stub Issue',
  description: '',
  state: { id: 'stub-state', name: 'Todo', type: 'unstarted' },
  assignee: null,
  createdAt: '2023-01-01T00:00:00.000Z',
});
export const mcp_linear_save_issue = async (..._args: unknown[]) => ({
  id: 'stub-issue',
  title: 'Stub Issue',
  description: '',
  state: { id: 'stub-state', name: 'Todo', type: 'unstarted' },
  assignee: null,
  createdAt: '2023-01-01T00:00:00.000Z',
});
