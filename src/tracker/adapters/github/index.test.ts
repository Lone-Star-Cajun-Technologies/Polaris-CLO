import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ClientRequest } from "node:http";
import { EventEmitter } from "node:events";

// ──────────────────────────────────────────────────────────────────────────────
// Mock node:https before importing the adapter so the adapter picks it up.
// ──────────────────────────────────────────────────────────────────────────────

// vi.mock is hoisted to the top of the file, so the factory must only reference
// variables created with vi.hoisted() — not regular top-level const declarations.
const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));

vi.mock("node:https", () => ({
  request: mockRequest,
}));

// Now import the adapter (after the mock is in place).
import { GitHubIssuesAdapter } from "./index.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Creates a minimal fake Node.js IncomingMessage with the given status code.
 * Data and end events are NOT pre-scheduled — call `drainResponse` to emit them.
 */
function fakeResponse(statusCode: number): IncomingMessage {
  const res = new EventEmitter() as IncomingMessage;
  (res as unknown as { statusCode: number }).statusCode = statusCode;
  return res;
}

/**
 * Creates a fake ClientRequest that accepts `write`/`end`/`setTimeout` calls.
 */
function fakeClientRequest(): ClientRequest {
  const req = new EventEmitter() as ClientRequest;
  (req as unknown as { write: (d: string) => void }).write = vi.fn();
  (req as unknown as { end: () => void }).end = vi.fn();
  (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = vi.fn();
  return req;
}

/**
 * Sets up `mockRequest` so that successive calls return the given responses
 * in order. Each element is `[statusCode, body]`.
 *
 * The response data/end events are emitted AFTER the callback attaches its
 * listeners (two nextTick hops: one to invoke callback, one to emit events).
 */
function stubResponses(responses: Array<[number, unknown]>): void {
  mockRequest.mockReset();

  for (const [statusCode, body] of responses) {
    mockRequest.mockImplementationOnce(
      (_options: unknown, callback: (res: IncomingMessage) => void) => {
        const res = fakeResponse(statusCode);
        const req = fakeClientRequest();
        // First nextTick: invoke the callback so the adapter attaches its
        // "data" and "end" listeners to `res`.
        process.nextTick(() => {
          callback(res);
          // Second nextTick: now emit data + end after listeners are attached.
          process.nextTick(() => {
            res.emit("data", Buffer.from(JSON.stringify(body)));
            res.emit("end");
          });
        });
        return req;
      },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared adapter instance
// ──────────────────────────────────────────────────────────────────────────────

const adapterConfig = {
  owner: "test-owner",
  repo: "test-repo",
  token: "ghp_test_token",
};

function makeAdapter(labelPrefix?: string): GitHubIssuesAdapter {
  return new GitHubIssuesAdapter({ ...adapterConfig, ...(labelPrefix ? { labelPrefix } : {}) });
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("GitHubIssuesAdapter", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  // ── 1. getCapabilities ─────────────────────────────────────────────────────

  describe("getCapabilities", () => {
    it("returns the expected capability shape", () => {
      const adapter = makeAdapter();
      const caps = adapter.getCapabilities();

      expect(caps.supportsChildRelationships).toBe(false);
      expect(caps.supportsStatusUpdates).toBe(true);
      expect(caps.supportsComments).toBe(true);
      expect(caps.supportsLinks).toBe(false);
      expect(caps.supportsDependencies).toBe(false);
      expect(caps.supportsLifecycleMapping).toBe(true);
      expect(caps.supportsCreateChild).toBe(false);
    });
  });

  // ── 2. mapNativeStatus ────────────────────────────────────────────────────

  describe("mapNativeStatus", () => {
    it('maps "open" to in_progress', () => {
      const adapter = makeAdapter();
      const result = adapter.mapNativeStatus("open");
      expect(result.lifecycleState).toBe("in_progress");
      expect(result.supported).toBe(true);
    });

    it('maps "closed" to done', () => {
      const adapter = makeAdapter();
      const result = adapter.mapNativeStatus("closed");
      expect(result.lifecycleState).toBe("done");
      expect(result.supported).toBe(true);
    });

    it('maps "status:in-review" to in_review', () => {
      const adapter = makeAdapter();
      const result = adapter.mapNativeStatus("status:in-review");
      expect(result.lifecycleState).toBe("in_review");
      expect(result.supported).toBe(true);
    });

    it('maps "status:in-progress" to in_progress', () => {
      const adapter = makeAdapter();
      const result = adapter.mapNativeStatus("status:in-progress");
      expect(result.lifecycleState).toBe("in_progress");
      expect(result.supported).toBe(true);
    });

    it('maps "status:blocked" to blocked', () => {
      const adapter = makeAdapter();
      const result = adapter.mapNativeStatus("status:blocked");
      expect(result.lifecycleState).toBe("blocked");
      expect(result.supported).toBe(true);
    });

    it("returns no_status_change and unsupported for an unknown value", () => {
      const adapter = makeAdapter();
      const result = adapter.mapNativeStatus("pending");
      expect(result.lifecycleState).toBe("no_status_change");
      expect(result.supported).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("respects a custom labelPrefix", () => {
      const adapter = makeAdapter("state/");
      const result = adapter.mapNativeStatus("state/in-review");
      expect(result.lifecycleState).toBe("in_review");
      expect(result.supported).toBe(true);
    });
  });

  // ── 3. transitionLifecycleState → "in_review" ────────────────────────────

  describe("transitionLifecycleState", () => {
    it('transitions to "in_review": fetches issue, updates state to open, removes old label, adds new label', async () => {
      const adapter = makeAdapter();

      // Sequence of HTTP calls made by transitionLifecycleState:
      //   1. GET  /repos/owner/repo/issues/7   → current issue
      //   2. PATCH /repos/owner/repo/issues/7  → set open/closed state
      //   3. DELETE /repos/owner/repo/issues/7/labels/status%3Ain-progress → remove old label
      //   4. POST  /repos/owner/repo/issues/7/labels → add new label
      stubResponses([
        [200, { number: 7, state: "open", labels: [{ name: "status:in-progress" }] }],
        [200, { number: 7, state: "open", labels: [] }],
        [200, []],  // DELETE label returns remaining labels array
        [200, [{ name: "status:in-review" }]],
      ]);

      const result = await adapter.transitionLifecycleState("7", "in_review");

      expect(result.applied).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.error).toBeUndefined();

      // Verify the four API calls were made
      expect(mockRequest).toHaveBeenCalledTimes(4);

      // 1. GET the issue
      const [getOpts] = mockRequest.mock.calls[0] as [{ method: string; path: string }, unknown];
      expect(getOpts.method).toBe("GET");
      expect(getOpts.path).toBe("/repos/test-owner/test-repo/issues/7");

      // 2. PATCH the state
      const [patchOpts] = mockRequest.mock.calls[1] as [{ method: string; path: string }, unknown];
      expect(patchOpts.method).toBe("PATCH");
      expect(patchOpts.path).toBe("/repos/test-owner/test-repo/issues/7");

      // 3. DELETE the old label
      const [deleteOpts] = mockRequest.mock.calls[2] as [{ method: string; path: string }, unknown];
      expect(deleteOpts.method).toBe("DELETE");
      expect(deleteOpts.path).toContain("/labels/");

      // 4. POST the new label
      const [postOpts] = mockRequest.mock.calls[3] as [{ method: string; path: string }, unknown];
      expect(postOpts.method).toBe("POST");
      expect(postOpts.path).toBe("/repos/test-owner/test-repo/issues/7/labels");
    });

    it('transitions to "done" sets state to "closed"', async () => {
      const adapter = makeAdapter();

      stubResponses([
        [200, { number: 8, state: "open", labels: [] }],
        [200, { number: 8, state: "closed", labels: [] }],
        [200, [{ name: "status:done" }]],
      ]);

      const result = await adapter.transitionLifecycleState("8", "done");
      expect(result.applied).toBe(true);

      // Second call (PATCH) should have closed state
      const patchOpts = mockRequest.mock.calls[1][0] as { method: string };
      expect(patchOpts.method).toBe("PATCH");

      // Verify the PATCH body sets state to "closed"
      const patchReq = mockRequest.mock.results[1]?.value as { write: ReturnType<typeof vi.fn> };
      const [patchPayload] = patchReq.write.mock.calls[0] as [string];
      expect(JSON.parse(patchPayload)).toEqual({ state: "closed" });
    });

    it("skips when lifecycleState is no_status_change", async () => {
      const adapter = makeAdapter();

      const result = await adapter.transitionLifecycleState("9", "no_status_change");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBeDefined();
      // No HTTP calls should have been made
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("returns error when API call fails", async () => {
      const adapter = makeAdapter();

      stubResponses([[404, { message: "Not Found" }]]);

      const result = await adapter.transitionLifecycleState("999", "in_review");
      expect(result.applied).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ── 5. addComment ─────────────────────────────────────────────────────────

  describe("addComment", () => {
    it("posts to the comments endpoint and returns added: true on success", async () => {
      const adapter = makeAdapter();

      stubResponses([[201, { id: 1, body: "hello" }]]);

      const result = await adapter.addComment("42", "hello");

      expect(result.added).toBe(true);
      expect(result.unsupported).toBe(false);
      expect(result.error).toBeUndefined();

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const [opts] = mockRequest.mock.calls[0] as [{ method: string; path: string }, unknown];
      expect(opts.method).toBe("POST");
      expect(opts.path).toBe("/repos/test-owner/test-repo/issues/42/comments");
    });

    it("returns error when the API call fails", async () => {
      const adapter = makeAdapter();

      stubResponses([[422, { message: "Validation Failed" }]]);

      const result = await adapter.addComment("42", "hello");
      expect(result.added).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ── 6. attachLink ─────────────────────────────────────────────────────────

  describe("attachLink", () => {
    it("returns unsupported: true without making any HTTP call", async () => {
      const adapter = makeAdapter();

      const result = await adapter.attachLink("1", "https://example.com", "Example");

      expect(result.attached).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(result.reason).toBeDefined();
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  // ── addDependency (bonus) ──────────────────────────────────────────────────

  describe("addDependency", () => {
    it("returns unsupported: true without making any HTTP call", async () => {
      const adapter = makeAdapter();
      const result = await adapter.addDependency("1", "2");
      expect(result.added).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  // ── createChild (bonus) ───────────────────────────────────────────────────

  describe("createChild", () => {
    it("returns created: false, unsupported: true without making any HTTP call", async () => {
      const adapter = makeAdapter();
      const result = await adapter.createChild("1", "child title");
      expect(result.created).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(result.reason).toBeDefined();
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });
});
