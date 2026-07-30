import { describe, expect, it } from "vitest";
import { mapBootstrapPacketToPaperclipIssue, validateSuccessfulRunHandoff } from "./paperclip.js";
import type { BootstrapPacket } from "./types.js";
import type { PaperclipRuntimeConfig } from "./paperclip.js";

const FOREMAN_ID = "7e7e6e43-505e-4edb-bf6b-7cb54aab261c";
const WORKER_ID = "b3caa4b2-0578-40ee-8042-42bffd6fcb5c";

const mockConfig: PaperclipRuntimeConfig = {
  baseUrl: "http://localhost:3100",
  companyId: "test-company",
  assigneeAgentId: FOREMAN_ID,
  tokenEnv: "TEST_TOKEN",
  runIdEnv: "TEST_RUN_ID",
  roleRegistry: {
    foreman: [FOREMAN_ID],
    worker: [WORKER_ID, "another-worker-id"],
  },
  resolvedToken: "test-token",
};

const basePacket: BootstrapPacket = {
  schema_version: "1.0",
  run_id: "test-run-1",
  cluster_id: "test-cluster-1",
  active_child: "LSCH-4",
  state_file: "/tmp/state.json",
  telemetry_file: "/tmp/telemetry.jsonl",
};

describe("mapBootstrapPacketToPaperclipIssue — foreman self-assignment validation", () => {
  it("rejects when foreman is assigned to a worker role", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: FOREMAN_ID,
          },
        },
        worker_role: "worker",
      },
    };

    expect(() => mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1")).toThrow(
      /Foreman.*cannot self-assign to a child work slot/,
    );
  });

  it("rejects when foreman is assigned to an analyst role", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: FOREMAN_ID,
          },
        },
        worker_role: "analyst",
      },
    };

    expect(() => mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1")).toThrow(
      /Foreman.*cannot self-assign to a child work slot/,
    );
  });

  it("rejects when foreman is assigned to a repair role", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: FOREMAN_ID,
          },
        },
        worker_role: "repair",
      },
    };

    expect(() => mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1")).toThrow(
      /Foreman.*cannot self-assign to a child work slot/,
    );
  });

  it("allows worker assignment to a non-foreman agent", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: WORKER_ID,
          },
        },
        worker_role: "worker",
      },
    };

    const result = mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1");
    expect(result.assigneeAgentId).toBe(WORKER_ID);
  });

  it("includes projectId in the payload when configured", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: WORKER_ID,
          },
        },
        worker_role: "worker",
      },
    };

    const result = mapBootstrapPacketToPaperclipIssue(
      packet,
      { ...mockConfig, projectId: "a6671feb-84f8-4b93-8ff7-3c8a6954a172" },
      "dispatch-1",
    );
    expect(result.projectId).toBe("a6671feb-84f8-4b93-8ff7-3c8a6954a172");
  });

  it("omits projectId from the payload when not configured", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: WORKER_ID,
          },
        },
        worker_role: "worker",
      },
    };

    const result = mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1");
    expect(result.projectId).toBeUndefined();
  });

  it("attaches executionState with monitor participants and wakes the reviewer when monitorRoles is configured", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: WORKER_ID,
          },
        },
        worker_role: "worker",
      },
    };

    const approverId = "af226c67-3541-45ba-839a-b2fafb4ea75c";
    const reviewerId = "98f310f0-1062-48a3-b02f-6dae833859fb";
    const result = mapBootstrapPacketToPaperclipIssue(
      packet,
      { ...mockConfig, monitorRoles: { approver: approverId, reviewer: reviewerId } },
      "dispatch-1",
    );

    expect(result.executionState).toEqual({
      participants: [approverId, reviewerId],
      currentParticipant: reviewerId,
      wakeRole: "reviewer",
    });
  });

  it("omits executionState from the payload when monitorRoles is not configured", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: WORKER_ID,
          },
        },
        worker_role: "worker",
      },
    };

    const result = mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1");
    expect(result.executionState).toBeUndefined();
  });

  it("allows foreman to take foreman roles", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: FOREMAN_ID,
          },
        },
        worker_role: "foreman",
      },
    };

    const result = mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1");
    expect(result.assigneeAgentId).toBe(FOREMAN_ID);
  });

  it("allows librarian role assignment by foreman", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        execution: {
          paperclip: {
            assigneeAgentId: FOREMAN_ID,
          },
        },
        worker_role: "librarian",
      },
    };

    const result = mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1");
    expect(result.assigneeAgentId).toBe(FOREMAN_ID);
  });

  it("throws when resolving defaults to foreman for worker role", () => {
    const packet: BootstrapPacket = {
      ...basePacket,
      context: {
        worker_role: "worker",
      },
    };

    expect(() => mapBootstrapPacketToPaperclipIssue(packet, mockConfig, "dispatch-1")).toThrow(
      /Foreman.*cannot self-assign to a child work slot/,
    );
  });
});

describe("validateSuccessfulRunHandoff — disposition validation", () => {
  it("accepts resolved state", () => {
    const issue = {
      successfulRunHandoff: {
        state: "resolved",
        required: true,
        hasLiveContinuation: false,
        sourceRunId: null,
        correctiveRunId: null,
        assigneeAgentId: "agent-1",
        detectedProgressSummary: "Done",
        createdAt: new Date().toISOString(),
      },
    };
    expect(validateSuccessfulRunHandoff(issue as any)).toEqual({ valid: true });
  });

  it("accepts escalated state with correctiveRunId", () => {
    const issue = {
      successfulRunHandoff: {
        state: "escalated",
        required: true,
        hasLiveContinuation: false,
        sourceRunId: null,
        correctiveRunId: "corrective-run-1",
        assigneeAgentId: "agent-1",
        detectedProgressSummary: "Escalated",
        createdAt: new Date().toISOString(),
      },
    };
    expect(validateSuccessfulRunHandoff(issue as any)).toEqual({ valid: true });
  });

  it("accepts escalated state with hasLiveContinuation", () => {
    const issue = {
      successfulRunHandoff: {
        state: "escalated",
        required: true,
        hasLiveContinuation: true,
        sourceRunId: null,
        correctiveRunId: null,
        assigneeAgentId: "agent-1",
        detectedProgressSummary: "Escalated",
        createdAt: new Date().toISOString(),
      },
    };
    expect(validateSuccessfulRunHandoff(issue as any)).toEqual({ valid: true });
  });

  it("rejects escalated state without correctiveRunId or hasLiveContinuation", () => {
    const issue = {
      successfulRunHandoff: {
        state: "escalated",
        required: true,
        hasLiveContinuation: false,
        sourceRunId: null,
        correctiveRunId: null,
        assigneeAgentId: "agent-1",
        detectedProgressSummary: "Escalated",
        createdAt: new Date().toISOString(),
      },
    };
    const result = validateSuccessfulRunHandoff(issue as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("no corrective run or live continuation path");
  });

  it("rejects when successfulRunHandoff is missing", () => {
    const issue = {};
    const result = validateSuccessfulRunHandoff(issue as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("No successfulRunHandoff");
  });

  it("rejects required state that was not resolved", () => {
    const issue = {
      successfulRunHandoff: {
        state: "required",
        required: true,
        hasLiveContinuation: false,
        sourceRunId: null,
        correctiveRunId: null,
        assigneeAgentId: "agent-1",
        detectedProgressSummary: null,
        createdAt: new Date().toISOString(),
      },
    };
    const result = validateSuccessfulRunHandoff(issue as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("did not resolve");
  });

  it("rejects unknown state", () => {
    const issue = {
      successfulRunHandoff: {
        state: "unknown",
        required: true,
        hasLiveContinuation: false,
        sourceRunId: null,
        correctiveRunId: null,
        assigneeAgentId: "agent-1",
        detectedProgressSummary: null,
        createdAt: new Date().toISOString(),
      },
    };
    const result = validateSuccessfulRunHandoff(issue as any);
    expect(result.valid).toBe(false);
    expect(result.message).toContain("Unknown successfulRunHandoff state");
  });
});
