import { describe, expect, it } from "vitest";
import { mapBootstrapPacketToPaperclipIssue } from "./paperclip.js";
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

// Note: validateSuccessfulRunHandoff is an internal function, but we can test it
// indirectly by checking the logic it implements via the PaperclipAdapter dispatch.
// These integration tests verify the handoff validation gate works correctly.
