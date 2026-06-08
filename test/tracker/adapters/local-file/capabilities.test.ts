import { describe, it, expect } from "vitest";
import { LocalFileAdapter } from "../../../../src/tracker/adapters/local-file/index.js";

describe("LocalFileAdapter Capabilities", () => {
  const adapter = new LocalFileAdapter();

  describe("getCapabilities", () => {
    it("should return correct capabilities", () => {
      const capabilities = adapter.getCapabilities();

      expect(capabilities).toEqual({
        supportsChildRelationships: true,
        supportsStatusUpdates: true,
        supportsComments: false,
        supportsLinks: false,
        supportsDependencies: true,
        supportsLifecycleMapping: true,
        supportsCreateChild: true,
      });
    });

    it("should not support comments", () => {
      const capabilities = adapter.getCapabilities();
      expect(capabilities.supportsComments).toBe(false);
    });

    it("should not support links", () => {
      const capabilities = adapter.getCapabilities();
      expect(capabilities.supportsLinks).toBe(false);
    });
  });

  describe("mapNativeStatus", () => {
    it("should map all valid normalized lifecycle states", () => {
      const validStates = ["backlog", "in_progress", "in_review", "done", "blocked", "cancelled", "no_status_change"];

      for (const state of validStates) {
        const result = adapter.mapNativeStatus(state);
        expect(result.lifecycleState).toBe(state);
        expect(result.supported).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("should be case-insensitive", () => {
      const result1 = adapter.mapNativeStatus("BACKLOG");
      const result2 = adapter.mapNativeStatus("backlog");
      const result3 = adapter.mapNativeStatus("BaCkLoG");

      expect(result1.lifecycleState).toBe("backlog");
      expect(result2.lifecycleState).toBe("backlog");
      expect(result3.lifecycleState).toBe("backlog");
    });

    it("should handle whitespace", () => {
      const result = adapter.mapNativeStatus("  in_progress  ");

      expect(result.lifecycleState).toBe("in_progress");
      expect(result.supported).toBe(true);
    });

    it("should return unsupported for unknown states", () => {
      const result = adapter.mapNativeStatus("Custom State");

      expect(result.lifecycleState).toBe("no_status_change");
      expect(result.supported).toBe(false);
      expect(result.reason).toContain("Custom State");
      expect(result.reason).toContain("Valid states are");
    });
  });

  describe("transitionLifecycleState", () => {
    it("should skip no_status_change transitions", async () => {
      const result = await adapter.transitionLifecycleState("task-1", "no_status_change");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("no_status_change");
    });

    it("should return skip result for implemented transitions", async () => {
      const result = await adapter.transitionLifecycleState("task-1", "in_progress");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("not yet implemented");
    });
  });

  describe("addComment", () => {
    it("should return unsupported result", async () => {
      const result = await adapter.addComment("task-1", "Test comment");

      expect(result.added).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(result.reason).toContain("does not support comments");
    });
  });

  describe("attachLink", () => {
    it("should return unsupported result", async () => {
      const result = await adapter.attachLink("task-1", "https://example.com");

      expect(result.attached).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(result.reason).toContain("does not support link attachments");
    });
  });

  describe("addDependency", () => {
    it("should return not implemented result", async () => {
      const result = await adapter.addDependency("task-1", "task-2");

      expect(result.added).toBe(false);
      expect(result.unsupported).toBe(false);
      expect(result.error).toContain("not yet implemented");
    });
  });

  describe("createChild", () => {
    it("should return not implemented result", async () => {
      const result = await adapter.createChild("task-1", "Child Title", "Child Body");

      expect(result.created).toBe(false);
      expect(result.unsupported).toBe(false);
      expect(result.error).toContain("not yet implemented");
    });
  });
});