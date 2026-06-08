import type { NormalizedLifecycleState, TrackerLifecyclePolicy } from "../config/schema.js";

// Re-export TrackerLifecyclePolicy for use in other tracker modules
export type { TrackerLifecyclePolicy };

/**
 * Transition event types that can occur during Polaris execution.
 */
export type LifecycleTransitionEvent =
  | "child-dispatch"
  | "child-validation-passed"
  | "child-merged"
  | "parent-all-children-complete"
  | "parent-delivery-merged"
  | "child-triage-required"
  | "provider-failure-before-work";

/**
 * Result of resolving a lifecycle transition.
 */
export interface LifecycleTransitionResult {
  /** The normalized lifecycle state to transition to. */
  targetState: NormalizedLifecycleState;
  /** Whether this transition should be skipped (e.g., unsupported by adapter). */
  skip: boolean;
  /** Reason for skipping, if applicable. */
  skipReason?: string;
  /** Evidence requirements for this transition (e.g., commit hash, PR link). */
  evidenceRequirements?: string[];
}

/**
 * Resolves lifecycle transitions based on policy configuration.
 *
 * This resolver provides tracker-agnostic lifecycle semantics by mapping
 * Polaris execution events to normalized lifecycle states defined in config.
 * Individual tracker adapters then map these normalized states to their
 * native status names or return unsupported-transition results.
 *
 * @param event - The lifecycle transition event to resolve.
 * @param policy - The tracker lifecycle policy from config.
 * @returns A transition result with target state, skip behavior, and evidence requirements.
 */
export function resolveLifecycleTransition(
  event: LifecycleTransitionEvent,
  policy?: TrackerLifecyclePolicy,
): LifecycleTransitionResult {
  const effectivePolicy = policy || getDefaultLifecyclePolicy();

  switch (event) {
    case "child-dispatch":
      return {
        targetState: effectivePolicy.childOnDispatch || "in_progress",
        skip: false,
        evidenceRequirements: [],
      };

    case "child-validation-passed":
      return {
        targetState: effectivePolicy.childOnValidationPassed || "in_review",
        skip: false,
        evidenceRequirements: ["validation_results", "worker_commit"],
      };

    case "child-merged":
      return {
        targetState: effectivePolicy.childOnMerged || "done",
        skip: false,
        evidenceRequirements: ["merge_commit_hash"],
      };

    case "parent-all-children-complete":
      return {
        targetState: effectivePolicy.parentOnAllChildrenComplete || "in_review",
        skip: false,
        evidenceRequirements: ["completed_children_summary"],
      };

    case "parent-delivery-merged":
      return {
        targetState: effectivePolicy.parentOnDeliveryMerged || "done",
        skip: false,
        evidenceRequirements: ["delivery_merge_commit_hash"],
      };

    case "child-triage-required":
      return {
        targetState: effectivePolicy.childOnTriageRequired || "blocked",
        skip: false,
        evidenceRequirements: ["triage_reason", "failure_details"],
      };

    case "provider-failure-before-work":
      return {
        targetState: effectivePolicy.providerFailureBeforeWork || "no_status_change",
        skip: effectivePolicy.providerFailureBeforeWork === "no_status_change",
        skipReason: effectivePolicy.providerFailureBeforeWork === "no_status_change"
          ? "Provider failure before repo work does not change implementation status"
          : undefined,
        evidenceRequirements: ["failure_error", "provider_context"],
      };

    default:
      // Unknown event - treat as no-op
      return {
        targetState: "no_status_change",
        skip: true,
        skipReason: `Unknown lifecycle event: ${event}`,
        evidenceRequirements: [],
      };
  }
}

/**
 * Returns the default lifecycle policy with review-gated behavior.
 *
 * Defaults preserve current behavior:
 * - Validation-passed transitions to in_review (review-gated)
 * - Parent completion transitions to in_review (review-gated)
 * - Provider failures before work do not change status (avoid false failures)
 */
export function getDefaultLifecyclePolicy(): Required<TrackerLifecyclePolicy> {
  return {
    childOnDispatch: "in_progress",
    childOnValidationPassed: "in_review",
    childOnMerged: "done",
    parentOnAllChildrenComplete: "in_review",
    parentOnDeliveryMerged: "done",
    childOnTriageRequired: "blocked",
    providerFailureBeforeWork: "no_status_change",
  };
}

/**
 * Validates a lifecycle policy value.
 *
 * @param policy - The policy to validate.
 * @returns Validation result with errors if invalid.
 */
export function validateLifecyclePolicy(policy: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!policy || typeof policy !== "object") {
    return { valid: false, errors: ["Lifecycle policy must be an object"] };
  }

  const validStates: NormalizedLifecycleState[] = [
    "backlog",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled",
    "no_status_change",
  ];

  const policyObj = policy as Record<string, unknown>;

  const validateField = (fieldName: string, value: unknown) => {
    if (value !== undefined && typeof value !== "string") {
      errors.push(`tracker.lifecyclePolicy.${fieldName} must be a string`);
      return;
    }
    if (value !== undefined && !validStates.includes(value as NormalizedLifecycleState)) {
      errors.push(
        `tracker.lifecyclePolicy.${fieldName} must be one of: ${validStates.join(", ")}`,
      );
    }
  };

  validateField("childOnDispatch", policyObj.childOnDispatch);
  validateField("childOnValidationPassed", policyObj.childOnValidationPassed);
  validateField("childOnMerged", policyObj.childOnMerged);
  validateField("parentOnAllChildrenComplete", policyObj.parentOnAllChildrenComplete);
  validateField("parentOnDeliveryMerged", policyObj.parentOnDeliveryMerged);
  validateField("childOnTriageRequired", policyObj.childOnTriageRequired);
  validateField("providerFailureBeforeWork", policyObj.providerFailureBeforeWork);

  return { valid: errors.length === 0, errors };
}