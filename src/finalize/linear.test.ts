import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

// ──────────────────────────────────────────────────────────────────────────────
// Mock node:https before any imports that use it
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("node:https", () => ({
  request: vi.fn(),
}));

import * as https from "node:https";
import {
  assertNotDoneState,
  findReviewState,
  updateLinearIssueAfterFinalize,
  buildFollowUpIssuePayload,
  createLinearFollowUpIssue,
} from "./linear.js";
import type { LoopState } from "../loop/checkpoint.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const mockRequest = vi.mocked(https.request);

type ResponseSpec = { statusCode: number; body: unknown };

/**
 * Configures the mocked https.request to respond sequentially with the given
 * list of response specs. Each call to request() consumes one spec.
 */
function setupMockResponses(responses: ResponseSpec[]): void {
  let index = 0;
  mockRequest.mockImplementation((_options: unknown, callback?: unknown) => {
    const spec = responses[index++] ?? { statusCode: 200, body: { data: {} } };
    const req = new EventEmitter() as ReturnType<typeof https.request>;
    (req as unknown as { write: () => void; end: () => void }).write = vi.fn();
    (req as unknown as { write: () => void; end: () => void }).end = vi.fn(() => {
      const res = new EventEmitter() as IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = spec.statusCode;
      if (typeof callback === "function") callback(res);
      res.emit("data", Buffer.from(JSON.stringify(spec.body)));
      res.emit("end");
    });
    return req as ReturnType<typeof https.request>;
  });
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: "POL-1",
    active_child: "",
    completed_children: ["POL-2", "POL-3"],
    open_children: [],
    step_cursor: "CLUSTER-COMPLETE",
    context_budget: { children_completed: 2 },
    status: "complete",
    next_open_child: null,
    ...overrides,
  } as unknown as LoopState;
}

// ──────────────────────────────────────────────────────────────────────────────
// assertNotDoneState
// ──────────────────────────────────────────────────────────────────────────────

describe("assertNotDoneState", () => {
  it("throws for 'completed' type", () => {
    expect(() => assertNotDoneState("completed", "Done")).toThrow(
      /prohibited from transitioning/,
    );
  });

  it("throws for 'cancelled' type", () => {
    expect(() => assertNotDoneState("cancelled", "Cancelled")).toThrow(
      /prohibited from transitioning/,
    );
  });

  it("throws for uppercase 'COMPLETED' (case-insensitive)", () => {
    expect(() => assertNotDoneState("COMPLETED", "Done")).toThrow(
      /prohibited from transitioning/,
    );
  });

  it("does NOT throw for 'review' type", () => {
    expect(() => assertNotDoneState("review", "In Review")).not.toThrow();
  });

  it("does NOT throw for 'started' type", () => {
    expect(() => assertNotDoneState("started", "In Progress")).not.toThrow();
  });

  it("error message names the attempted state", () => {
    expect(() => assertNotDoneState("completed", "My Done State")).toThrow(/"My Done State"/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// findReviewState
// ──────────────────────────────────────────────────────────────────────────────

describe("findReviewState", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("returns a state when type is 'review'", async () => {
    setupMockResponses([
      // issue team query
      { statusCode: 200, body: { data: { issue: { team: { id: "team-1" } } } } },
      // workflow states query
      {
        statusCode: 200,
        body: {
          data: {
            workflowStates: {
              nodes: [
                { id: "state-done", name: "Done", type: "completed" },
                { id: "state-review", name: "In Review", type: "review" },
                { id: "state-todo", name: "Todo", type: "unstarted" },
              ],
            },
          },
        },
      },
    ]);

    const result = await findReviewState("issue-abc", "api-key");
    expect(result).toEqual({ id: "state-review", name: "In Review", type: "review" });
  });

  it("matches by name 'In Review' when type is not 'review'", async () => {
    setupMockResponses([
      { statusCode: 200, body: { data: { issue: { team: { id: "team-1" } } } } },
      {
        statusCode: 200,
        body: {
          data: {
            workflowStates: {
              nodes: [
                { id: "state-inreview", name: "In Review", type: "started" },
                { id: "state-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      },
    ]);

    const result = await findReviewState("issue-abc", "api-key");
    expect(result).toEqual({ id: "state-inreview", name: "In Review", type: "started" });
  });

  it("matches by name 'Review' (case-insensitive)", async () => {
    setupMockResponses([
      { statusCode: 200, body: { data: { issue: { team: { id: "team-1" } } } } },
      {
        statusCode: 200,
        body: {
          data: {
            workflowStates: {
              nodes: [{ id: "state-rev", name: "review", type: "started" }],
            },
          },
        },
      },
    ]);

    const result = await findReviewState("issue-abc", "api-key");
    expect(result).toEqual({ id: "state-rev", name: "review", type: "started" });
  });

  it("returns null when no review state exists", async () => {
    setupMockResponses([
      { statusCode: 200, body: { data: { issue: { team: { id: "team-1" } } } } },
      {
        statusCode: 200,
        body: {
          data: {
            workflowStates: {
              nodes: [
                { id: "state-todo", name: "Todo", type: "unstarted" },
                { id: "state-done", name: "Done", type: "completed" },
              ],
            },
          },
        },
      },
    ]);

    const result = await findReviewState("issue-abc", "api-key");
    expect(result).toBeNull();
  });

  it("returns null when issue has no team", async () => {
    setupMockResponses([
      { statusCode: 200, body: { data: { issue: {} } } },
    ]);

    const result = await findReviewState("issue-abc", "api-key");
    expect(result).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// updateLinearIssueAfterFinalize
// ──────────────────────────────────────────────────────────────────────────────

describe("updateLinearIssueAfterFinalize", () => {
  const baseOptions = {
    issueId: "issue-abc",
    state: makeState(),
    branch: "pol-1-delivery",
    prUrl: "https://github.com/org/repo/pull/42",
    validationPassed: true,
    apiKey: "lin_api_test",
  };

  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("calls issueUpdate then commentCreate when a review state is found", async () => {
    const calls: string[] = [];

    mockRequest.mockImplementation((_options: unknown, callback?: unknown) => {
      const req = new EventEmitter() as ReturnType<typeof https.request>;
      (req as unknown as { write: (data: string) => void }).write = vi.fn((data: string) => {
        const parsed = JSON.parse(data) as { query?: string };
        const query = parsed.query ?? "";
        if (query.includes("GetIssueTeam")) calls.push("getIssueTeam");
        else if (query.includes("GetWorkflowStates")) calls.push("getWorkflowStates");
        else if (query.includes("UpdateIssueState")) calls.push("issueUpdate");
        else if (query.includes("CreateComment")) calls.push("commentCreate");
      });

      (req as unknown as { end: () => void }).end = vi.fn(() => {
        const res = new EventEmitter() as IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = 200;
        if (typeof callback === "function") callback(res);

        let body: unknown;
        const callName = calls[calls.length - 1];
        if (callName === "getIssueTeam") {
          body = { data: { issue: { team: { id: "team-x" } } } };
        } else if (callName === "getWorkflowStates") {
          body = {
            data: {
              workflowStates: {
                nodes: [{ id: "rev-state-id", name: "In Review", type: "review" }],
              },
            },
          };
        } else if (callName === "issueUpdate") {
          body = { data: { issueUpdate: { success: true } } };
        } else {
          body = { data: { commentCreate: { success: true } } };
        }
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });

      return req as ReturnType<typeof https.request>;
    });

    await updateLinearIssueAfterFinalize(baseOptions);

    expect(calls).toContain("issueUpdate");
    expect(calls).toContain("commentCreate");
    // issueUpdate must precede commentCreate
    expect(calls.indexOf("issueUpdate")).toBeLessThan(calls.indexOf("commentCreate"));
  });

  it("does NOT call issueUpdate and includes a missing-state note when no review state exists", async () => {
    let commentBody = "";
    const calls: string[] = [];

    mockRequest.mockImplementation((_options: unknown, callback?: unknown) => {
      const req = new EventEmitter() as ReturnType<typeof https.request>;
      (req as unknown as { write: (data: string) => void }).write = vi.fn((data: string) => {
        const parsed = JSON.parse(data) as { query?: string; variables?: Record<string, unknown> };
        const query = parsed.query ?? "";
        if (query.includes("GetIssueTeam")) {
          calls.push("getIssueTeam");
        } else if (query.includes("GetWorkflowStates")) {
          calls.push("getWorkflowStates");
        } else if (query.includes("UpdateIssueState")) {
          calls.push("issueUpdate");
        } else if (query.includes("CreateComment")) {
          calls.push("commentCreate");
          commentBody = (parsed.variables?.["body"] as string) ?? "";
        }
      });

      (req as unknown as { end: () => void }).end = vi.fn(() => {
        const res = new EventEmitter() as IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = 200;
        if (typeof callback === "function") callback(res);

        let body: unknown;
        const callName = calls[calls.length - 1];
        if (callName === "getIssueTeam") {
          body = { data: { issue: { team: { id: "team-x" } } } };
        } else if (callName === "getWorkflowStates") {
          body = {
            data: {
              workflowStates: {
                nodes: [{ id: "done-state", name: "Done", type: "completed" }],
              },
            },
          };
        } else {
          body = { data: { commentCreate: { success: true } } };
        }
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });

      return req as ReturnType<typeof https.request>;
    });

    await updateLinearIssueAfterFinalize(baseOptions);

    expect(calls).not.toContain("issueUpdate");
    expect(calls).toContain("commentCreate");
    expect(commentBody).toMatch(/No "In Review" workflow state found/);
  });

  it("comment body does NOT include missing-state note when review state was found", async () => {
    let commentBody = "";
    const calls: string[] = [];

    mockRequest.mockImplementation((_options: unknown, callback?: unknown) => {
      const req = new EventEmitter() as ReturnType<typeof https.request>;
      (req as unknown as { write: (data: string) => void }).write = vi.fn((data: string) => {
        const parsed = JSON.parse(data) as { query?: string; variables?: Record<string, unknown> };
        const query = parsed.query ?? "";
        if (query.includes("GetIssueTeam")) {
          calls.push("getIssueTeam");
        } else if (query.includes("GetWorkflowStates")) {
          calls.push("getWorkflowStates");
        } else if (query.includes("UpdateIssueState")) {
          calls.push("issueUpdate");
        } else if (query.includes("CreateComment")) {
          calls.push("commentCreate");
          commentBody = (parsed.variables?.["body"] as string) ?? "";
        }
      });

      (req as unknown as { end: () => void }).end = vi.fn(() => {
        const res = new EventEmitter() as IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = 200;
        if (typeof callback === "function") callback(res);

        let body: unknown;
        const callName = calls[calls.length - 1];
        if (callName === "getIssueTeam") {
          body = { data: { issue: { team: { id: "team-x" } } } };
        } else if (callName === "getWorkflowStates") {
          body = {
            data: {
              workflowStates: {
                nodes: [{ id: "rev-id", name: "In Review", type: "review" }],
              },
            },
          };
        } else if (callName === "issueUpdate") {
          body = { data: { issueUpdate: { success: true } } };
        } else {
          body = { data: { commentCreate: { success: true } } };
        }
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });

      return req as ReturnType<typeof https.request>;
    });

    await updateLinearIssueAfterFinalize(baseOptions);

    expect(commentBody).not.toMatch(/No "In Review" workflow state found/);
    expect(commentBody).toContain("polaris finalize complete");
  });

  it("falls back to comment-only when state query fails (network error)", async () => {
    let callCount = 0;
    const calls: string[] = [];

    mockRequest.mockImplementation((_options: unknown, callback?: unknown) => {
      const req = new EventEmitter() as ReturnType<typeof https.request>;
      (req as unknown as { write: (data: string) => void }).write = vi.fn((data: string) => {
        callCount++;
        const parsed = JSON.parse(data) as { query?: string };
        const q = parsed.query ?? "";
        if (q.includes("GetIssueTeam")) calls.push("getIssueTeam");
        else if (q.includes("CreateComment")) calls.push("commentCreate");
      });

      (req as unknown as { end: () => void }).end = vi.fn(() => {
        // First call (getIssueTeam) — simulate network error
        if (callCount === 1) {
          req.emit("error", new Error("simulated network error"));
        } else {
          const res = new EventEmitter() as IncomingMessage;
          (res as unknown as { statusCode: number }).statusCode = 200;
          if (typeof callback === "function") callback(res);
          res.emit("data", Buffer.from(JSON.stringify({ data: { commentCreate: { success: true } } })));
          res.emit("end");
        }
      });

      return req as ReturnType<typeof https.request>;
    });

    await expect(updateLinearIssueAfterFinalize(baseOptions)).resolves.toBeUndefined();
    expect(calls).toContain("commentCreate");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Follow-up issue creation
// ──────────────────────────────────────────────────────────────────────────────

describe("buildFollowUpIssuePayload", () => {
  it("includes parentId, title, and description", () => {
    const payload = buildFollowUpIssuePayload({
      parentIssueId: "parent-1",
      title: "Follow-up: fix style issue",
      description: "QC finding routed to follow-up.",
      apiKey: "key",
    });
    expect(payload.variables.input).toMatchObject({
      title: "Follow-up: fix style issue",
      description: "QC finding routed to follow-up.",
      parentId: "parent-1",
    });
  });

  it("omits optional fields when not provided", () => {
    const payload = buildFollowUpIssuePayload({
      parentIssueId: "parent-1",
      title: "Follow-up",
      description: "desc",
      apiKey: "key",
    });
    expect(payload.variables.input).not.toHaveProperty("teamId");
    expect(payload.variables.input).not.toHaveProperty("stateId");
    expect(payload.variables.input).not.toHaveProperty("labelIds");
  });
});

describe("createLinearFollowUpIssue", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("returns the created issue identifiers on success", async () => {
    mockRequest.mockImplementation((_options: unknown, callback?: unknown) => {
      const req = new EventEmitter() as ReturnType<typeof https.request>;
      (req as unknown as { write: () => void; end: () => void }).write = vi.fn();
      (req as unknown as { write: () => void; end: () => void }).end = vi.fn(() => {
        const res = new EventEmitter() as IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = 200;
        if (typeof callback === "function") callback(res);
        res.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              data: {
                issueCreate: {
                  success: true,
                  issue: { id: "issue-1", identifier: "POL-500", url: "https://linear.app/issue/POL-500" },
                },
              },
            }),
          ),
        );
        res.emit("end");
      });
      return req as ReturnType<typeof https.request>;
    });

    const result = await createLinearFollowUpIssue({
      parentIssueId: "parent-1",
      title: "Follow-up",
      description: "desc",
      apiKey: "key",
    });

    expect(result).toEqual({
      id: "issue-1",
      identifier: "POL-500",
      url: "https://linear.app/issue/POL-500",
    });
  });

  it("throws when Linear issueCreate fails", async () => {
    mockRequest.mockImplementation((_options: unknown, callback?: unknown) => {
      const req = new EventEmitter() as ReturnType<typeof https.request>;
      (req as unknown as { write: () => void; end: () => void }).write = vi.fn();
      (req as unknown as { write: () => void; end: () => void }).end = vi.fn(() => {
        const res = new EventEmitter() as IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = 200;
        if (typeof callback === "function") callback(res);
        res.emit("data", Buffer.from(JSON.stringify({ data: { issueCreate: { success: false } } })));
        res.emit("end");
      });
      return req as ReturnType<typeof https.request>;
    });

    await expect(
      createLinearFollowUpIssue({
        parentIssueId: "parent-1",
        title: "Follow-up",
        description: "desc",
        apiKey: "key",
      }),
    ).rejects.toThrow("Linear issueCreate failed");
  });
});
