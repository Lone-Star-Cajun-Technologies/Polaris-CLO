import type { NormalizedLifecycleState } from "../config/schema.js";

/**
 * Represents the capabilities a tracker adapter supports.
 */
export interface TrackerCapabilities {
  /** Whether the tracker supports parent-child relationships. */
  supportsChildRelationships: boolean;
  /** Whether the tracker supports status updates. */
  supportsStatusUpdates: boolean;
  /** Whether the tracker supports comments. */
  supportsComments: boolean;
  /** Whether the tracker supports attaching links. */
  supportsLinks: boolean;
  /** Whether the tracker supports dependency relations. */
  supportsDependencies: boolean;
  /** Whether the tracker supports lifecycle state mapping. */
  supportsLifecycleMapping: boolean;
  /** Whether the tracker supports creating child tasks. */
  supportsCreateChild: boolean;
}

/**
 * Result of mapping a native status to a normalized lifecycle state.
 */
export interface StatusMappingResult {
  /** The normalized lifecycle state. */
  lifecycleState: NormalizedLifecycleState;
  /** Whether this mapping is supported. */
  supported: boolean;
  /** Reason for unsupported mapping, if applicable. */
  reason?: string;
}

/**
 * Result of a lifecycle state transition attempt.
 */
export interface LifecycleTransitionResult {
  /** Whether the transition was applied. */
  applied: boolean;
  /** Whether the transition was skipped due to lack of support. */
  skipped: boolean;
  /** Reason for skipping, if applicable. */
  skipReason?: string;
  /** Error message if the transition failed. */
  error?: string;
}

/**
 * Result of a comment addition attempt.
 */
export interface CommentResult {
  /** Whether the comment was added. */
  added: boolean;
  /** Whether adding comments is not supported. */
  unsupported: boolean;
  /** Reason for lack of support, if applicable. */
  reason?: string;
  /** Error message if adding the comment failed. */
  error?: string;
}

/**
 * Result of a link attachment attempt.
 */
export interface LinkResult {
  /** Whether the link was attached. */
  attached: boolean;
  /** Whether attaching links is not supported. */
  unsupported: boolean;
  /** Reason for lack of support, if applicable. */
  reason?: string;
  /** Error message if attaching the link failed. */
  error?: string;
}

/**
 * Result of a dependency relation attempt.
 */
export interface DependencyResult {
  /** Whether the dependency was added. */
  added: boolean;
  /** Whether dependencies are not supported. */
  unsupported: boolean;
  /** Reason for lack of support, if applicable. */
  reason?: string;
  /** Error message if adding the dependency failed. */
  error?: string;
}

/**
 * Result of a child creation attempt.
 */
export interface CreateChildResult {
  /** Whether the child was created. */
  created: boolean;
  /** Whether creating children is not supported. */
  unsupported: boolean;
  /** Reason for lack of support, if applicable. */
  reason?: string;
  /** Error message if creating the child failed. */
  error?: string;
  /** The ID of the created child, if successful. */
  childId?: string;
}

/**
 * Common tracker adapter interface for capability-based operations.
 *
 * This interface extends the basic TrackerAdapter with explicit capability
 * descriptors and lifecycle state mapping. All tracker adapters should
 * implement this interface to provide consistent behavior and clear
 * communication about what operations they support.
 */
export interface CapableTrackerAdapter {
  /**
   * Returns the capabilities supported by this tracker adapter.
   */
  getCapabilities(): TrackerCapabilities;

  /**
   * Maps a native tracker status to a normalized lifecycle state.
   *
   * @param nativeStatus - The native status string from the tracker.
   * @returns A status mapping result with the normalized state and support status.
   */
  mapNativeStatus(nativeStatus: string): StatusMappingResult;

  /**
   * Attempts to transition a task to a lifecycle state.
   *
   * @param taskId - The ID of the task to transition.
   * @param lifecycleState - The target normalized lifecycle state.
   * @param evidence - Optional evidence for the transition (e.g., commit hash).
   * @returns A lifecycle transition result indicating success, skip, or failure.
   */
  transitionLifecycleState(
    taskId: string,
    lifecycleState: NormalizedLifecycleState,
    evidence?: Record<string, unknown>,
  ): Promise<LifecycleTransitionResult>;

  /**
   * Adds a comment to a task.
   *
   * @param taskId - The ID of the task.
   * @param body - The comment body text.
   * @returns A comment result indicating success, skip, or failure.
   */
  addComment(taskId: string, body: string): Promise<CommentResult>;

  /**
   * Attaches a link to a task.
   *
   * @param taskId - The ID of the task.
   * @param url - The URL to attach.
   * @param title - Optional title for the link.
   * @returns A link result indicating success, skip, or failure.
   */
  attachLink(taskId: string, url: string, title?: string): Promise<LinkResult>;

  /**
   * Adds a dependency relation between tasks.
   *
   * @param taskId - The ID of the task that depends on another.
   * @param dependsOnTaskId - The ID of the task that is depended on.
   * @returns A dependency result indicating success, skip, or failure.
   */
  addDependency(taskId: string, dependsOnTaskId: string): Promise<DependencyResult>;

  /**
   * Creates a child task under a parent task.
   *
   * @param parentId - The ID of the parent task.
   * @param title - The title of the child task.
   * @param body - Optional body/description of the child task.
   * @returns A create child result indicating success, skip, or failure.
   */
  createChild(parentId: string, title: string, body?: string): Promise<CreateChildResult>;
}