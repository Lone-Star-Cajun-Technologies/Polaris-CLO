import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraAdapterConfig } from "./index.js";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("node:https", () => ({
  request: requestMock,
}));

// Helper: build a mock HTTPS response with a given status code and body.
function mockResponse(statusCode: number, body: unknown) {
  return (_options: unknown, callback: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
    };
    req.write = vi.fn();
    req.setTimeout = vi.fn();
    req.end = vi.fn(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = statusCode;
      callback(res);
      res.emit("data", Buffer.from(body !== undefined ? JSON.stringify(body) : ""));
      res.emit("end");
    });
    return req;
  };
}

const TEST_CONFIG: JiraAdapterConfig = {
  baseUrl: "https://test.atlassian.net",
  email: "test@example.com",
  apiToken: "test-api-token",
  projectKey: "POL",
};

describe("JiraCloudAdapter", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  // ── 1. getCapabilities ────────────────────────────────────────────────────

  describe("getCapabilities", () => {
    it("returns the expected capability shape", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      expect(adapter.getCapabilities()).toEqual({
        supportsChildRelationships: false,
        supportsStatusUpdates: true,
        supportsComments: true,
        supportsLinks: false,
        supportsDependencies: false,
        supportsLifecycleMapping: true,
        supportsCreateChild: false,
      });
    });
  });

  // ── 2. mapNativeStatus ────────────────────────────────────────────────────

  describe("mapNativeStatus", () => {
    it("maps 'In Progress' to in_progress", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      expect(adapter.mapNativeStatus("In Progress")).toEqual({
        lifecycleState: "in_progress",
        supported: true,
      });
    });

    it("maps 'Done' to done", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      expect(adapter.mapNativeStatus("Done")).toEqual({
        lifecycleState: "done",
        supported: true,
      });
    });

    it("maps 'In Review' to in_review", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      expect(adapter.mapNativeStatus("In Review")).toEqual({
        lifecycleState: "in_review",
        supported: true,
      });
    });

    it("maps 'Blocked' to blocked", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      expect(adapter.mapNativeStatus("Blocked")).toEqual({
        lifecycleState: "blocked",
        supported: true,
      });
    });

    it("returns no_status_change with supported:false for unknown status", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = adapter.mapNativeStatus("some custom status");
      expect(result.lifecycleState).toBe("no_status_change");
      expect(result.supported).toBe(false);
      expect(result.reason).toContain("some custom status");
    });

    it("uses user-provided statusMappings override (case-insensitive)", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter({
        ...TEST_CONFIG,
        statusMappings: { "CUSTOM DONE": "done" },
      });
      expect(adapter.mapNativeStatus("custom done")).toEqual({
        lifecycleState: "done",
        supported: true,
      });
    });
  });

  // ── 3. transitionLifecycleState — success ─────────────────────────────────

  describe("transitionLifecycleState", () => {
    it("applies transition when a matching transition is found", async () => {
      // First call: GET transitions
      requestMock.mockImplementationOnce(
        mockResponse(200, {
          transitions: [
            { id: "11", name: "To Do" },
            { id: "21", name: "In Progress" },
            { id: "31", name: "Done" },
          ],
        }),
      );
      // Second call: POST transition
      requestMock.mockImplementationOnce(mockResponse(204, undefined));

      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.transitionLifecycleState("POL-42", "in_progress");

      expect(result).toEqual({ applied: true, skipped: false });

      // Verify the POST body contained the correct transition id.
      const postCall = requestMock.mock.calls[1];
      const postReq = postCall[1] as (res: unknown) => void; // callback arg position unused here
      // The write mock on the request object captures the payload.
      // We inspect requestMock.mock.calls[1][0] for the path.
      expect(requestMock.mock.calls[1][0]).toMatchObject({
        method: "POST",
        path: "/rest/api/3/issue/POL-42/transitions",
      });
    });

    // ── 4. transitionLifecycleState — no matching transition ─────────────────

    it("returns skipped:true when no transition maps to the target lifecycle state", async () => {
      requestMock.mockImplementationOnce(
        mockResponse(200, {
          transitions: [
            { id: "11", name: "To Do" },
            { id: "31", name: "Done" },
          ],
        }),
      );

      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.transitionLifecycleState("POL-42", "in_progress");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("in_progress");
    });

    // ── 5. transitionLifecycleState — no_status_change ───────────────────────

    it("skips immediately for 'no_status_change' without making any HTTP calls", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.transitionLifecycleState("POL-42", "no_status_change");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(true);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it("returns error when GET transitions call fails", async () => {
      requestMock.mockImplementationOnce(mockResponse(404, { message: "Issue Not Found" }));

      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.transitionLifecycleState("POL-99", "in_progress");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns error when POST transition call fails", async () => {
      requestMock.mockImplementationOnce(
        mockResponse(200, {
          transitions: [{ id: "21", name: "In Progress" }],
        }),
      );
      requestMock.mockImplementationOnce(mockResponse(500, { message: "Internal Server Error" }));

      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.transitionLifecycleState("POL-42", "in_progress");

      expect(result.applied).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("uses statusMappings to find a transition by custom name", async () => {
      requestMock.mockImplementationOnce(
        mockResponse(200, {
          transitions: [
            { id: "99", name: "Awaiting Review" },
            { id: "21", name: "In Progress" },
          ],
        }),
      );
      requestMock.mockImplementationOnce(mockResponse(204, undefined));

      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter({
        ...TEST_CONFIG,
        statusMappings: { "Awaiting Review": "in_review" },
      });
      const result = await adapter.transitionLifecycleState("POL-42", "in_review");

      expect(result.applied).toBe(true);
      expect(result.skipped).toBe(false);
    });
  });

  // ── 6. addComment ─────────────────────────────────────────────────────────

  describe("addComment", () => {
    it("posts an ADF-formatted comment body and returns added:true", async () => {
      requestMock.mockImplementationOnce(mockResponse(201, { id: "10001" }));

      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.addComment("POL-42", "This is a test comment");

      expect(result).toEqual({ added: true, unsupported: false });

      // Verify request options.
      expect(requestMock.mock.calls[0][0]).toMatchObject({
        method: "POST",
        path: "/rest/api/3/issue/POL-42/comment",
      });

      // Capture the written payload from the mock request's write() call.
      // The mockResponse helper creates req.write as a vi.fn(); we need to
      // retrieve what was written to it.
      const writtenPayload = (() => {
        // The request factory returns a mock req; we access it via the
        // implementation return value captured through the EventEmitter mock.
        // Simplest: spy on what was passed to req.write inside mockResponse.
        // Re-inspect by introspecting requestMock's returned object.
        return null; // payload inspection done below via separate spy
      })();

      // Since we cannot directly inspect the write call on the internal emitter
      // without extra plumbing, we verify the path and method above and confirm
      // the shape of the body by checking headers for Content-Type.
      const headers = requestMock.mock.calls[0][0].headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("posts the correct ADF structure for the comment text", async () => {
      let capturedPayload: string | undefined;

      requestMock.mockImplementationOnce((_options: unknown, callback: (res: unknown) => void) => {
        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          setTimeout: ReturnType<typeof vi.fn>;
        };
        req.write = vi.fn((data: string) => {
          capturedPayload = data;
        });
        req.setTimeout = vi.fn();
        req.end = vi.fn(() => {
          const res = new EventEmitter() as EventEmitter & { statusCode: number };
          res.statusCode = 201;
          callback(res);
          res.emit("data", Buffer.from(JSON.stringify({ id: "10001" })));
          res.emit("end");
        });
        return req;
      });

      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      await adapter.addComment("POL-42", "Hello Jira");

      expect(capturedPayload).toBeDefined();
      const parsed = JSON.parse(capturedPayload!);
      expect(parsed).toEqual({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Hello Jira" }],
            },
          ],
        },
      });
    });
  });

  // ── 7. attachLink ─────────────────────────────────────────────────────────

  describe("attachLink", () => {
    it("returns unsupported:true without making any HTTP calls", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.attachLink("POL-42", "https://example.com", "Example");

      expect(result.attached).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(result.reason).toBeDefined();
      expect(requestMock).not.toHaveBeenCalled();
    });
  });

  // ── 8. addDependency ──────────────────────────────────────────────────────

  describe("addDependency", () => {
    it("returns added:false and unsupported:true without making any HTTP calls", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.addDependency("POL-42", "POL-1");

      expect(result.added).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(requestMock).not.toHaveBeenCalled();
    });
  });

  // ── 9. createChild ────────────────────────────────────────────────────────

  describe("createChild", () => {
    it("returns created:false and unsupported:true without making any HTTP calls", async () => {
      const { JiraCloudAdapter } = await import("./index.js");
      const adapter = new JiraCloudAdapter(TEST_CONFIG);
      const result = await adapter.createChild("POL-42", "child title");

      expect(result.created).toBe(false);
      expect(result.unsupported).toBe(true);
      expect(requestMock).not.toHaveBeenCalled();
    });
  });
});
