import { describe, expect, it } from "vitest";
import type { ExecutionConfig } from "../../config/schema.js";
import { createAdapter } from "./registry.js";

const paperclipConfig: ExecutionConfig = {
  adapter: "terminal-cli",
  providers: {},
  paperclip: {
    enabled: false,
    baseUrl: "http://127.0.0.1:3100",
    companyId: "e4e9384a-d4a5-46f2-a444-92f5aa6ebdc6",
    assigneeAgentId: "39f35fc9-5434-4226-83e3-a435809aac81",
    tokenEnv: "PAPERCLIP_TOKEN",
    runIdEnv: "PAPERCLIP_RUN_ID",
  },
};

describe("createAdapter — Paperclip feature gate", () => {
  it("keeps terminal-cli available while Paperclip is disabled", () => {
    expect(createAdapter("terminal-cli", paperclipConfig).name).toBe("terminal-cli");
  });

  it("rejects Paperclip until explicitly enabled", () => {
    expect(() => createAdapter("paperclip", paperclipConfig)).toThrow(
      "Paperclip adapter is disabled",
    );
  });
});
