import { describe, it, expect, vi } from "vitest";
import { LifecycleTransitionService } from "./lifecycle-transition.js";
import type {
  CapableTrackerAdapter,
  LifecycleTransitionResult as AdapterLifecycleTransitionResult,
} from "./capabilities.js";
import type { NormalizedLifecycleState } from "../config/schema.js";
import type { TrackerLifecyclePolicy } from "../config/schema.js";

// Mock adapter for testing
class MockAdapter implements CapableTrackerAdapter {
  getCapabilities() {
    return {
      supportsChildRelationships: true,
      supportsStatusUpdates: true,
      supportsComments: true,
      supportsLinks: true,
      supportsDependencies: true,
      supportsLifecycleMapping: true,
      supportsCreateChild: true,
    };
  }

  mapNativeStatus(_nativeStatus: string) {
    return { lifecycleState: "in_progress" as NormalizedLifecycleState, supported: true };
  }

  async transitionLifecycleState(
    _taskId: string,
    lifecycleState: NormalizedLifecycleState,
    _evidence?: Record<string, unknown>,
  ): Promise<AdapterLifecycleTransitionResult> {
    if (lifecycleState === "no_status_change") {
      return {
        applied: false,
        skipped: true,
        skipReason: "Lifecycle state is 'no_status_change', skipping transition",
      };
    }
    return {
      applied: true,
      skipped: false,
    };
  }

  async addComment(_taskId: string, _body: string) {
    return { added: false, unsupported: false };
  }

  async attachLink(_taskId: string, _url: string, _title?: string) {
    return { attached: false, unsupported: false };
  }

  async addDependency(_taskId: string, _dependsOnTaskId: string) {
    return { added: false, unsupported: false };
  }

  async createChild(_parentId: string, _title: string, _body?: string) {
    return { created: false, unsupported: false };
  }
}

// Mock adapter without lifecycle mapping support
class MockAdapterNoLifecycle implements CapableTrackerAdapter {
  getCapabilities() {
    return {
      supportsChildRelationships: true,
      supportsStatusUpdates: true,
      supportsComments: false,
      supportsLinks: false,
      supportsDependencies: true,
      supportsLifecycleMapping: false, // Not supported
      supportsCreateChild: true,
    };
  }

  mapNativeStatus(_nativeStatus: string) {
    return { lifecycleState: "in_progress" as NormalizedLifecycleState, supported: true };
  }

  async transitionLifecycleState(
    _taskId: string,
    _lifecycleState: NormalizedLifecycleState,
    _evidence?: Record<string, unknown>,
  ): Promise<AdapterLifecycleTransitionResult> {
    return {
      applied: false,
      skipped: true,
      skipReason: "Lifecycle mapping not supported",
    };
  }

  async addComment(_taskId: string, _body: string) {
    return { added: false, unsupported: true };
  }

  async attachLink(_taskId: string, _url: string, _title?: string) {
    return { attached: false, unsupported: true };
  }

  async addDependency(_taskId: string, _dependsOnTaskId: string) {
    return { added: false, unsupported: false };
  }

  async createChild(_parentId: string, _title: string, _body?: string) {
    return { created: false, unsupported: false };
  }
}

describe("LifecycleTransitionService", () => {
  describe("applyTransition", () => {
    it("applies transition when adapter supports it and policy allows it", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();
      const policy: TrackerLifecyclePolicy = {
        childOnDispatch: "in_progress",
      };

      const result = await service.applyTransition({
        adapter,
        policy,
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      expect(result.applied).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.targetState).toBe("in_progress");
      expect(result.event).toBe("child-dispatch");
    });

    it("skips transition when policy says no_status_change", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();
      const policy: TrackerLifecyclePolicy = {
        providerFailureBeforeWork: "no_status_change",
      };

      const result = await service.applyTransition({
        adapter,
        policy,
        taskId: "TASK-123",
        event: "provider-failure-before-work",
      });

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("Provider failure before repo work does not change implementation status");
      expect(result.targetState).toBe("no_status_change");
    });

    it("skips transition when no adapter is configured", async () => {
      const service = new LifecycleTransitionService();
      const policy: TrackerLifecyclePolicy = {
        childOnDispatch: "in_progress",
      };

      const result = await service.applyTransition({
        adapter: null,
        policy,
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("No tracker adapter configured");
    });

    it("skips transition when adapter does not support lifecycle mapping", async () => {
      const adapter = new MockAdapterNoLifecycle();
      const service = new LifecycleTransitionService();
      const policy: TrackerLifecyclePolicy = {
        childOnDispatch: "in_progress",
      };

      const result = await service.applyTransition({
        adapter,
        policy,
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("Tracker adapter does not support lifecycle mapping");
    });

    it("skips transition when adapter returns skip result", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();
      
      // Override transitionLifecycleState to return skip
      adapter.transitionLifecycleState = vi.fn().mockResolvedValue({
        applied: false,
        skipped: true,
        skipReason: "Adapter-specific skip reason",
      });

      const result = await service.applyTransition({
        adapter,
        policy: { childOnDispatch: "in_progress" },
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("Adapter-specific skip reason");
    });

    it("records error when adapter transition fails", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();
      
      // Override transitionLifecycleState to return error
      adapter.transitionLifecycleState = vi.fn().mockResolvedValue({
        applied: false,
        skipped: false,
        error: "Adapter error",
      });

      const result = await service.applyTransition({
        adapter,
        policy: { childOnDispatch: "in_progress" },
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.error).toBe("Adapter error");
    });

    it("records error when adapter throws exception", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();
      
      // Override transitionLifecycleState to throw
      adapter.transitionLifecycleState = vi.fn().mockRejectedValue(new Error("Adapter threw"));

      const result = await service.applyTransition({
        adapter,
        policy: { childOnDispatch: "in_progress" },
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.error).toContain("Adapter threw exception");
    });

    it("passes evidence to adapter", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();
      
      const transitionSpy = vi.spyOn(adapter, "transitionLifecycleState");

      await service.applyTransition({
        adapter,
        policy: { childOnDispatch: "in_progress" },
        taskId: "TASK-123",
        event: "child-dispatch",
        evidence: {
          commit: "abc123",
          resultFile: "/path/to/result.json",
          validationResults: { passed: true },
        },
      });

      expect(transitionSpy).toHaveBeenCalledWith(
        "TASK-123",
        "in_progress",
        expect.objectContaining({
          commit: "abc123",
          resultFile: "/path/to/result.json",
          validationResults: { passed: true },
        }),
      );
    });

    it("uses default policy when no policy is provided", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();

      const result = await service.applyTransition({
        adapter,
        policy: undefined,
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      expect(result.applied).toBe(true);
      expect(result.targetState).toBe("in_progress"); // Default for child-dispatch
    });
  });

  describe("applyTransitionSafe", () => {
    it("returns error result when service throws exception", async () => {
      const adapter = new MockAdapter();
      const service = new LifecycleTransitionService();
      
      // Override transitionLifecycleState to throw
      adapter.transitionLifecycleState = vi.fn().mockRejectedValue(new Error("Test error"));

      const result = await service.applyTransitionSafe({
        adapter,
        policy: { childOnDispatch: "in_progress" },
        taskId: "TASK-123",
        event: "child-dispatch",
      });

      // Should not throw, but return error result
      expect(result.applied).toBe(false);
      expect(result.error).toContain("Adapter threw exception");
    });
  });
});