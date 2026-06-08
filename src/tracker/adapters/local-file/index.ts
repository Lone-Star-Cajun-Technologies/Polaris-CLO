import type {
  TrackerCapabilities,
  StatusMappingResult,
  LifecycleTransitionResult,
  CommentResult,
  LinkResult,
  DependencyResult,
  CreateChildResult,
  CapableTrackerAdapter,
} from "../../capabilities.js";
import type { NormalizedLifecycleState } from "../../../config/schema.js";

/**
 * Local-file tracker adapter for file-backed task management.
 *
 * This adapter provides a stable file-backed task model using the LocalGraph
 * execution graph as its backing store. It supports read operations and
 * limited mutation capabilities appropriate for local development workflows.
 */
export class LocalFileAdapter implements CapableTrackerAdapter {
  /**
   * Returns the capabilities supported by the local-file adapter.
   */
  getCapabilities(): TrackerCapabilities {
    return {
      supportsChildRelationships: true,
      supportsStatusUpdates: true,
      supportsComments: false, // Comments would require file format changes
      supportsLinks: false, // Links would require file format changes
      supportsDependencies: true,
      supportsLifecycleMapping: true,
      supportsCreateChild: true, // Via graph mutation
    };
  }

  /**
   * Maps a local-file status to a normalized lifecycle state.
   *
   * The local-file adapter uses the same normalized lifecycle states as
   * Polaris config, so mapping is straightforward.
   *
   * @param nativeStatus - The native status string from the local graph.
   * @returns A status mapping result with the normalized state and support status.
   */
  mapNativeStatus(nativeStatus: string): StatusMappingResult {
    const normalizedStatus = nativeStatus.toLowerCase().trim();

    // Local-file uses the same normalized lifecycle states
    const validStates: NormalizedLifecycleState[] = [
      "backlog",
      "in_progress",
      "in_review",
      "done",
      "blocked",
      "cancelled",
      "no_status_change",
    ];

    if (validStates.includes(normalizedStatus as NormalizedLifecycleState)) {
      return {
        lifecycleState: normalizedStatus as NormalizedLifecycleState,
        supported: true,
      };
    }

    return {
      lifecycleState: "no_status_change",
      supported: false,
      reason: `Unknown local-file status '${nativeStatus}'. Valid states are: ${validStates.join(", ")}`,
    };
  }

  /**
   * Attempts to transition a local-file task to a lifecycle state.
   *
   * This would update the task's status in the LocalGraph. For now,
   * this is a placeholder that returns skip results.
   *
   * @param taskId - The task ID in the local graph.
   * @param lifecycleState - The target normalized lifecycle state.
   * @param evidence - Optional evidence for the transition (e.g., commit hash).
   * @returns A lifecycle transition result indicating success, skip, or failure.
   */
  async transitionLifecycleState(
    taskId: string,
    lifecycleState: NormalizedLifecycleState,
    evidence?: Record<string, unknown>,
  ): Promise<LifecycleTransitionResult> {
    if (lifecycleState === "no_status_change") {
      return {
        applied: false,
        skipped: true,
        skipReason: "Lifecycle state is 'no_status_change', skipping transition",
      };
    }

    // Placeholder implementation - would update LocalGraph node status
    console.warn(
      `LocalFileAdapter: transitionLifecycleState not fully implemented. Would transition ${taskId} to ${lifecycleState}.`,
    );

    return {
      applied: false,
      skipped: true,
      skipReason: "Lifecycle state transitions are not yet implemented for local-file adapter",
    };
  }

  /**
   * Adds a comment to a local-file task.
   *
   * Comments are not currently supported by the local-file format.
   *
   * @param taskId - The task ID in the local graph.
   * @param body - The comment body text.
   * @returns A comment result indicating success, skip, or failure.
   */
  async addComment(taskId: string, body: string): Promise<CommentResult> {
    return {
      added: false,
      unsupported: true,
      reason: "Local-file adapter does not support comments. The file format does not include comment storage.",
    };
  }

  /**
   * Attaches a link to a local-file task.
   *
   * Links are not currently supported by the local-file format.
   *
   * @param taskId - The task ID in the local graph.
   * @param url - The URL to attach.
   * @param title - Optional title for the link.
   * @returns A link result indicating success, skip, or failure.
   */
  async attachLink(taskId: string, url: string, title?: string): Promise<LinkResult> {
    return {
      attached: false,
      unsupported: true,
      reason: "Local-file adapter does not support link attachments. The file format does not include link storage.",
    };
  }

  /**
   * Adds a dependency relation between local-file tasks.
   *
   * This would update the dependency map in the LocalGraph. For now,
   * this is a placeholder that returns skip results.
   *
   * @param taskId - The ID of the task that depends on another.
   * @param dependsOnTaskId - The ID of the task that is depended on.
   * @returns A dependency result indicating success, skip, or failure.
   */
  async addDependency(taskId: string, dependsOnTaskId: string): Promise<DependencyResult> {
    // Placeholder implementation - would update LocalGraph dependency map
    console.warn(
      `LocalFileAdapter: addDependency not fully implemented. Would add dependency from ${taskId} to ${dependsOnTaskId}.`,
    );

    return {
      added: false,
      unsupported: false,
      error: "Adding dependencies is not yet implemented for local-file adapter",
    };
  }

  /**
   * Creates a child task under a parent task in the local graph.
   *
   * This would create a new node in the LocalGraph. For now,
   * this is a placeholder that returns skip results.
   *
   * @param parentId - The ID of the parent task.
   * @param title - The title of the child task.
   * @param body - Optional body/description of the child task.
   * @returns A create child result indicating success, skip, or failure.
   */
  async createChild(parentId: string, title: string, body?: string): Promise<CreateChildResult> {
    // Placeholder implementation - would create new node in LocalGraph
    console.warn(
      `LocalFileAdapter: createChild not fully implemented. Would create child '${title}' under ${parentId}.`,
    );

    return {
      created: false,
      unsupported: false,
      error: "Creating child tasks is not yet implemented for local-file adapter",
    };
  }
}