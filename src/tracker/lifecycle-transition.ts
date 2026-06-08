import type { TrackerLifecyclePolicy } from "../config/schema.js";
import type {
  CapableTrackerAdapter,
  LifecycleTransitionResult as AdapterLifecycleTransitionResult,
} from "./capabilities.js";
import {
  resolveLifecycleTransition,
  type LifecycleTransitionEvent,
  type LifecycleTransitionResult as PolicyTransitionResult,
} from "./lifecycle-policy.js";
import type { NormalizedLifecycleState } from "../config/schema.js";

/**
 * Evidence for a lifecycle transition attempt.
 */
export interface TransitionEvidence {
  /** Commit hash if applicable. */
  commit?: string;
  /** Result file path if applicable. */
  resultFile?: string;
  /** Packet file path if applicable. */
  packetFile?: string;
  /** Validation results if applicable. */
  validationResults?: unknown;
  /** Error details if applicable. */
  error?: string;
  /** Provider context if applicable. */
  providerContext?: string;
}

/**
 * Result of a lifecycle transition attempt with full context.
 */
export interface LifecycleTransitionAttempt {
  /** The lifecycle transition event that was attempted. */
  event: LifecycleTransitionEvent;
  /** The target normalized lifecycle state from policy. */
  targetState: NormalizedLifecycleState;
  /** Whether the transition was applied to the tracker. */
  applied: boolean;
  /** Whether the transition was skipped (e.g., unsupported by adapter). */
  skipped: boolean;
  /** Reason for skipping, if applicable. */
  skipReason?: string;
  /** Error message if the transition failed. */
  error?: string;
  /** Evidence provided for the transition. */
  evidence?: TransitionEvidence;
  /** Timestamp of the attempt. */
  timestamp: string;
}

/**
 * Options for applying a lifecycle transition.
 */
export interface ApplyTransitionOptions {
  /** The tracker adapter to use for the transition. */
  adapter: CapableTrackerAdapter | null;
  /** The lifecycle policy from config. */
  policy?: TrackerLifecyclePolicy;
  /** The task ID to transition. */
  taskId: string;
  /** The lifecycle transition event. */
  event: LifecycleTransitionEvent;
  /** Evidence for the transition. */
  evidence?: TransitionEvidence;
  /** Timestamp of the attempt. */
  timestamp?: string;
}

/**
 * Service for applying tracker lifecycle transitions with policy and capability awareness.
 *
 * This service integrates the lifecycle policy resolver with tracker adapter capabilities
 * to ensure transitions are:
 * - Policy-backed: transitions follow the configured lifecycle policy
 * - Idempotent: skipped if the target state is already reached or unsupported
 * - Evidence-backed: requires evidence for validation-passed and merged transitions
 * - Safe: provider/runtime failures before work do not mark implementation failures by default
 */
export class LifecycleTransitionService {
  /**
   * Applies a lifecycle transition using the provided adapter and policy.
   *
   * @param options - The transition options.
   * @returns A transition attempt result.
   */
  async applyTransition(options: ApplyTransitionOptions): Promise<LifecycleTransitionAttempt> {
    const { adapter, policy, taskId, event, evidence, timestamp } = options;
    const effectiveTimestamp = timestamp ?? new Date().toISOString();

    // Resolve the transition from policy
    const policyResult: PolicyTransitionResult = resolveLifecycleTransition(event, policy);

    // If policy says skip, return immediately
    if (policyResult.skip) {
      return {
        event,
        targetState: policyResult.targetState,
        applied: false,
        skipped: true,
        skipReason: policyResult.skipReason,
        evidence,
        timestamp: effectiveTimestamp,
      };
    }

    // If no adapter is configured, skip with reason
    if (!adapter) {
      return {
        event,
        targetState: policyResult.targetState,
        applied: false,
        skipped: true,
        skipReason: "No tracker adapter configured",
        evidence,
        timestamp: effectiveTimestamp,
      };
    }

    // Check if adapter supports lifecycle mapping
    const capabilities = adapter.getCapabilities();
    if (!capabilities.supportsLifecycleMapping) {
      return {
        event,
        targetState: policyResult.targetState,
        applied: false,
        skipped: true,
        skipReason: "Tracker adapter does not support lifecycle mapping",
        evidence,
        timestamp: effectiveTimestamp,
      };
    }

    // Check if target state is no_status_change
    if (policyResult.targetState === "no_status_change") {
      return {
        event,
        targetState: policyResult.targetState,
        applied: false,
        skipped: true,
        skipReason: "Policy specifies no status change for this event",
        evidence,
        timestamp: effectiveTimestamp,
      };
    }

    // Build evidence record for the adapter
    const adapterEvidence: Record<string, unknown> = {};
    if (evidence?.commit) adapterEvidence.commit = evidence.commit;
    if (evidence?.resultFile) adapterEvidence.resultFile = evidence.resultFile;
    if (evidence?.packetFile) adapterEvidence.packetFile = evidence.packetFile;
    if (evidence?.validationResults) adapterEvidence.validationResults = evidence.validationResults;
    if (evidence?.error) adapterEvidence.error = evidence.error;
    if (evidence?.providerContext) adapterEvidence.providerContext = evidence.providerContext;

    // Attempt the transition through the adapter
    try {
      const adapterResult: AdapterLifecycleTransitionResult = await adapter.transitionLifecycleState(
        taskId,
        policyResult.targetState,
        adapterEvidence,
      );

      if (adapterResult.skipped) {
        return {
          event,
          targetState: policyResult.targetState,
          applied: false,
          skipped: true,
          skipReason: adapterResult.skipReason ?? "Adapter skipped the transition",
          evidence,
          timestamp: effectiveTimestamp,
        };
      }

      if (adapterResult.error) {
        return {
          event,
          targetState: policyResult.targetState,
          applied: false,
          skipped: false,
          error: adapterResult.error,
          evidence,
          timestamp: effectiveTimestamp,
        };
      }

      return {
        event,
        targetState: policyResult.targetState,
        applied: adapterResult.applied,
        skipped: false,
        evidence,
        timestamp: effectiveTimestamp,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        event,
        targetState: policyResult.targetState,
        applied: false,
        skipped: false,
        error: `Adapter threw exception: ${errorMessage}`,
        evidence,
        timestamp: effectiveTimestamp,
      };
    }
  }

  /**
   * Applies a lifecycle transition with a fallback to no-op if the adapter is not capable.
   *
   * This is a convenience method for cases where you want to attempt a transition
   * but not fail if the adapter doesn't support it.
   *
   * @param options - The transition options.
   * @returns A transition attempt result (never throws).
   */
  async applyTransitionSafe(options: ApplyTransitionOptions): Promise<LifecycleTransitionAttempt> {
    try {
      return await this.applyTransition(options);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        event: options.event,
        targetState: "no_status_change",
        applied: false,
        skipped: false,
        error: `Transition service threw exception: ${errorMessage}`,
        evidence: options.evidence,
        timestamp: options.timestamp ?? new Date().toISOString(),
      };
    }
  }
}