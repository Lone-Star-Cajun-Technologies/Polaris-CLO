import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolarisConfig } from "../../../config/schema.js";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("node:https", () => ({
  request: requestMock,
}));

describe("LinearAdapter HTTP error handling", () => {
  const originalApiKey = process.env["LINEAR_API_KEY"];

  beforeEach(() => {
    requestMock.mockReset();
  });

  it("includes non-2xx response body in thrown error", async () => {
    process.env["LINEAR_API_KEY"] = "linear-test-token";
    requestMock.mockImplementation((_options: any, callback: any) => {
      const req = new EventEmitter() as any;
      req.write = vi.fn();
      req.end = vi.fn(() => {
        const res = new EventEmitter() as any;
        res.statusCode = 400;
        callback(res);
        res.emit("data", Buffer.from(JSON.stringify({ errors: [{ message: "bad query" }] })));
        res.emit("end");
      });
      req.on = req.addListener.bind(req);
      return req;
    });

    try {
      vi.resetModules();
      const { LinearAdapter } = await import("./index.js");
      const config: PolarisConfig = {
        tracker: {
          linear: {
            enabled: true,
          },
        },
      };

      const adapter = new LinearAdapter(config);
      await expect(adapter.syncIn("POL-198")).rejects.toThrow(
        "Linear API returned 400: {\"errors\":[{\"message\":\"bad query\"}]}",
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env["LINEAR_API_KEY"];
      } else {
        process.env["LINEAR_API_KEY"] = originalApiKey;
      }
    }
  });
});
