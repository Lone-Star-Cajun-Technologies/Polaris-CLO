
import { TrackerAdapter, TrackerSyncInput, MutationRecord } from '../sync/index.js';
import { LinearIssue } from '../../types/linear.js';

type McpLinearTools = {
  mcp_linear_list_issues: (args: Record<string, unknown>) => Promise<unknown[]>;
  mcp_linear_save_issue: (args: Record<string, unknown>) => Promise<{ id: string }>;
};

const MCP_BRIDGE_UNAVAILABLE_MESSAGE =
  "MCP bridge adapter is unavailable because '@tool-server/linear' is not installed. Install MCP bridge dependencies or switch tracker.adapter to 'linear'.";

function isMissingModuleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("Cannot find module '@tool-server/linear'") ||
    error.message.includes("Cannot find package '@tool-server/linear'") ||
    error.message.includes("ERR_MODULE_NOT_FOUND")
  );
}

async function loadMcpLinearTools(): Promise<McpLinearTools> {
  try {
    const tools = await import("@tool-server/linear");
    return {
      mcp_linear_list_issues: tools.mcp_linear_list_issues,
      mcp_linear_save_issue: tools.mcp_linear_save_issue,
    };
  } catch (error) {
    if (isMissingModuleError(error)) {
      throw new Error(MCP_BRIDGE_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

/**
 * MCP Bridge Adapter for interacting with Linear via the MCP.
 * This adapter fetches issues from Linear and applies mutations (e.g., status updates) to Linear issues.
 */
export class McpBridgeAdapter implements TrackerAdapter {
  private readonly toolsLoader: () => Promise<McpLinearTools>;
  private toolsPromise: Promise<McpLinearTools> | undefined;
  
  constructor(toolsLoader: () => Promise<McpLinearTools> = loadMcpLinearTools) {
    this.toolsLoader = toolsLoader;
  }

  private async getTools(): Promise<McpLinearTools> {
    this.toolsPromise ??= this.toolsLoader().catch((error) => {
      this.toolsPromise = undefined;
      if (isMissingModuleError(error)) {
        throw new Error(MCP_BRIDGE_UNAVAILABLE_MESSAGE);
      }
      throw error;
    });
    return this.toolsPromise;
  }

  /**
   * Fetches data (issues) from Linear using the MCP bridge.
   * @param input - The sync input parameters, including the Linear team ID.
   * @returns A promise resolving to an array of Linear issues.
   */
  async fetchData(input: TrackerSyncInput): Promise<LinearIssue[]> {
    const { mcp_linear_list_issues } = await this.getTools();
    console.log(`McpBridgeAdapter: Fetching data for trackerId: ${input.trackerId}`);
    // Assuming input.trackerId contains the Linear team ID or can be derived from config
    // For now, let's assume we need a team ID to list issues. This will need to come from configuration.
    // As a placeholder, we'll use a hardcoded team if not provided in input.
    const teamId = input.trackerId; // This needs to be refined based on actual config
    if (!teamId) {
      console.warn('McpBridgeAdapter: No teamId provided in TrackerSyncInput. Cannot fetch issues.');
      return [];
    }

    try {
      const issues = await mcp_linear_list_issues({ team: teamId });
      console.log(`McpBridgeAdapter: Fetched ${issues.length} issues from Linear.`);
      return issues as LinearIssue[];
    } catch (error: any) {
      console.error('McpBridgeAdapter: Error fetching issues from Linear:', error);
      throw error;
    }
  }

  /**
   * Applies a mutation record to a Linear issue using the MCP bridge.
   * @param mutation - The mutation record to apply.
   * @returns A promise resolving to the updated mutation record.
   */
  async applyMutation(mutation: MutationRecord): Promise<MutationRecord> {
    const { mcp_linear_save_issue } = await this.getTools();
    console.log(`McpBridgeAdapter: Applying mutation for ID: ${mutation.id}, entityType: ${mutation.entityType}, entityId: ${mutation.entityId}`);

    if (mutation.entityType === 'issue' && mutation.type === 'update') {
      try {
        // Assuming payload contains fields to update in Linear issue
        const updatedIssue = await mcp_linear_save_issue({
          id: mutation.entityId,
          ...mutation.payload, // Spread the payload to update issue fields
        });
        console.log(`McpBridgeAdapter: Successfully updated Linear issue ${mutation.entityId}.`);
        return { ...mutation, status: 'succeeded', remoteId: updatedIssue.id };
      } catch (error: any) {
        console.error(`McpBridgeAdapter: Error updating Linear issue ${mutation.entityId}:`, error);
        return { ...mutation, status: 'failed', error: error.message };
      }
    } else if (mutation.entityType === 'issue' && mutation.type === 'create') {
        try {
            // Assuming payload contains fields to create a Linear issue
            if (!mutation.payload.team) {
                return { ...mutation, status: 'failed', error: 'Team is required for creating a Linear issue.' };
            }
            if (!mutation.payload.title) {
                return { ...mutation, status: 'failed', error: 'Title is required for creating a Linear issue.' };
            }
            const newIssue = await mcp_linear_save_issue({
                team: mutation.payload.team,
                title: mutation.payload.title,
                description: mutation.payload.description,
                // Add other fields as necessary from payload
                ...mutation.payload,
            });
            console.log(`McpBridgeAdapter: Successfully created Linear issue ${newIssue.id}.`);
            return { ...mutation, status: 'succeeded', remoteId: newIssue.id };
        } catch (error: any) {
            console.error(`McpBridgeAdapter: Error creating Linear issue:`, error);
            return { ...mutation, status: 'failed', error: error.message };
        }
    }

    // Handle other mutation types or entity types as needed
    console.warn(`McpBridgeAdapter: Unsupported mutation type or entity type: ${mutation.type} ${mutation.entityType}`);
    return { ...mutation, status: 'failed', error: 'Unsupported mutation type or entity type' };
  }

  /**
   * Compares local state with remote state to detect conflicts.
   * This is a placeholder and needs a proper implementation based on how local and remote entities are structured.
   * A common approach is to compare a "version" field or a hash of relevant fields.
   * @param localEntity - The local representation of an entity.
   * @param remoteEntity - The remote representation of the same entity.
   * @returns True if a conflict is detected, false otherwise.
   */
  detectConflict(localEntity: any, remoteEntity: any): boolean {
    // For a basic implementation, we can compare a lastUpdated timestamp or a content hash.
    // This will depend on the structure of localEntity and LinearIssue.
    // For now, a very basic comparison:
    if (!localEntity || !remoteEntity) {
      return false; // Cannot detect conflict if one is missing
    }
    // More sophisticated conflict detection would compare relevant fields, e.g.,
    // if (localEntity.lastUpdated > remoteEntity.updatedAt) { return true; }
    // Or if (JSON.stringify(localEntity.importantFields) !== JSON.stringify(remoteEntity.importantFields)) { return true; }
    console.log('McpBridgeAdapter: Simulating conflict detection (always false for now)');
    return false; // Placeholder
  }

  /**
   * Generates a remote fingerprint for a given Linear entity (issue).
   * This fingerprint can be used for quick comparison to detect changes.
   * @param entity - The entity to generate a fingerprint for.
   * @returns A string representing the remote fingerprint.
   */
  generateRemoteFingerprint(entity: LinearIssue): string {
    // A simple fingerprint could be a hash of the issue's content and its last update timestamp.
    // For Linear issues, `updatedAt` is a good candidate.
    return `${entity.id}-${entity.updatedAt}-${entity.title}-${entity.description}`; // Basic fingerprint
  }
}
