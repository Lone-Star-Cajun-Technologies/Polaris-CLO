import { describe, it, expect, vi } from "vitest";
import { LinearAdapter } from "../../../../src/tracker/adapters/linear/index.js";
import type { PolarisConfig } from "../../../../src/config/schema.js";

describe("LinearAdapter Capabilities", () => {
  const mockConfig: PolarisConfig = {
    tracker: {
      adapter: "linear",
      linear: {
        enabled: true,
        teamId: "test-team",
      },
    },
  };

  const adapter = new LinearAdapter(mockConfig);

  describe("getCapabilities", () => {
    it("should return all capabilities as supported", () => {
      const capabilities = adapter.getCapabilities();

      expect(capabilities).toEqual({
        supportsChildRelationships: true,
        supportsStatusUpdates: true,
        supportsComments: true,
        supportsLinks: true,
        supportsDependencies: true,
        supportsLifecycleMapping: true,
        supportsCreateChild: true,
      });
    });
  });

  describe("mapNativeStatus", () => {
    it("should map backlog states correctly", () => {
      const backlogStates = ["Backlog", "TODO", "Idea", "Suggestion", "Unstarted"];

      for (const state of backlogStates) {
        const result = adapter.mapNativeStatus(state);
        expect(result.lifecycleState).toBe("backlog");
        expect(result.supported).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("should map in-progress states correctly", () => {
      const inProgressStates = ["In Progress", "In-Progress", "Started", "Doing", "Active", "WIP"];

      for (const state of inProgressStates) {
        const result = adapter.mapNativeStatus(state);
        expect(result.lifecycleState).toBe("in_progress");
        expect(result.supported).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("should map in-review states correctly", () => {
      const inReviewStates = ["In Review", "In-Review", "Review", "Under Review", "Pending Review", "Ready for Review"];

      for (const state of inReviewStates) {
        const result = adapter.mapNativeStatus(state);
        expect(result.lifecycleState).toBe("in_review");
        expect(result.supported).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("should map done states correctly", () => {
      const doneStates = ["Done", "Completed", "Finished", "Closed", "Resolved", "Shipped", "Released"];

      for (const state of doneStates) {
        const result = adapter.mapNativeStatus(state);
        expect(result.lifecycleState).toBe("done");
        expect(result.supported).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("should map blocked states correctly", () => {
      const blockedStates = ["Blocked", "Blocked By", "Waiting", "On Hold", "Paused", "Stuck"];

      for (const state of blockedStates) {
        const result = adapter.mapNativeStatus(state);
        expect(result.lifecycleState).toBe("blocked");
        expect(result.supported).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("should map cancelled states correctly", () => {
      const cancelledStates = ["Cancelled", "Canceled", "Declined", "Won't Do", "Wont Do", "Duplicate", "Invalid"];

      for (const state of cancelledStates) {
        const result = adapter.mapNativeStatus(state);
        expect(result.lifecycleState).toBe("cancelled");
        expect(result.supported).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("should return unsupported for unknown states", () => {
      const result = adapter.mapNativeStatus("Custom Weird State");

      expect(result.lifecycleState).toBe("no_status_change");
      expect(result.supported).toBe(false);
      expect(result.reason).toContain("Custom Weird State");
      expect(result.reason).toContain("explicit state mapping configuration");
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
      const result = adapter.mapNativeStatus("  In Progress  ");

      expect(result.lifecycleState).toBe("in_progress");
      expect(result.supported).toBe(true);
    });
  });

  describe("transitionLifecycleState", () => {
    it("should skip no_status_change transitions", async () => {
      const result = await adapter.transitionLifecycleState("TEST-1", "no_status_change");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("no_status_change");
    });

    it("applies a real transition when a workflow state maps to the target lifecycle state", async () => {
      const linearClient = {
        listTeams: vi.fn(),
        listProjects: vi.fn(),
        listIssues: vi.fn(),
        getIssueById: vi.fn(),
        getIssueStateOptions: vi.fn().mockResolvedValue({
          currentStateId: "state-backlog",
          states: [
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-in-progress", name: "In Progress", type: "started" },
          ],
        }),
        updateIssueState: vi.fn().mockResolvedValue(true),
      };
      const adapterWithClient = new LinearAdapter(mockConfig, linearClient);

      const result = await adapterWithClient.transitionLifecycleState("TEST-1", "in_progress");

      expect(linearClient.updateIssueState).toHaveBeenCalledWith("TEST-1", "state-in-progress");
      expect(result.applied).toBe(true);
      expect(result.skipped).toBe(false);
    });
  });

  describe("addComment", () => {
    it("should return not implemented result", async () => {
      const result = await adapter.addComment("TEST-1", "Test comment");

      expect(result.added).toBe(false);
      expect(result.unsupported).toBe(false);
      expect(result.error).toContain("not yet implemented");
    });
  });

  describe("attachLink", () => {
    it("should return unsupported result", async () => {
      const result = await adapter.attachLink("TEST-1", "https://example.com");

      expect(result.attached).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(result.reason).toContain("does not have native link attachments");
    });
  });

  describe("addDependency", () => {
    it("should return not implemented result", async () => {
      const result = await adapter.addDependency("TEST-1", "TEST-2");

      expect(result.added).toBe(false);
      expect(result.unsupported).toBe(false);
      expect(result.error).toContain("not yet implemented");
    });
  });

  describe("createChild", () => {
    it("should return not implemented result", async () => {
      const result = await adapter.createChild("TEST-1", "Child Title", "Child Body");

      expect(result.created).toBe(false);
      expect(result.unsupported).toBe(false);
      expect(result.error).toContain("not yet implemented");
    });
  });
});