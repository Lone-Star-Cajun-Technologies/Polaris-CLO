import { describe, it, expect } from "vitest";
import {
  TerminalCliAdapter,
  AgentSubtaskAdapter,
  PaperclipAdapter,
  createAdapter,
  dispatchForeman,
} from "./index.js";
import { PaperclipAdapter as PaperclipAdapterDirect } from "./paperclip.js";
import { TerminalCliAdapter as TerminalCliAdapterDirect } from "./terminal-cli.js";
import { AgentSubtaskAdapter as AgentSubtaskAdapterDirect } from "./agent-subtask.js";
import { dispatchForeman as dispatchForemanDirect } from "./foreman-dispatch.js";

describe("adapters/index.ts barrel exports", () => {
  it("exports TerminalCliAdapter as the same reference as terminal-cli.js", () => {
    expect(TerminalCliAdapter).toBe(TerminalCliAdapterDirect);
  });

  it("exports AgentSubtaskAdapter as the same reference as agent-subtask.js", () => {
    expect(AgentSubtaskAdapter).toBe(AgentSubtaskAdapterDirect);
  });

  it("exports PaperclipAdapter as the same reference as paperclip.js", () => {
    expect(PaperclipAdapter).toBe(PaperclipAdapterDirect);
  });

  it("exports createAdapter and dispatchForeman as functions", () => {
    expect(typeof createAdapter).toBe("function");
    expect(typeof dispatchForeman).toBe("function");
    expect(dispatchForeman).toBe(dispatchForemanDirect);
  });

  it("createAdapter('paperclip', ...) resolved via the barrel returns a PaperclipAdapter instance", () => {
    const adapter = createAdapter("paperclip", { adapter: "paperclip", providers: {} });
    expect(adapter).toBeInstanceOf(PaperclipAdapter);
    expect(adapter.name).toBe("paperclip");
  });

  it("createAdapter('terminal-cli', ...) resolved via the barrel returns a TerminalCliAdapter instance", () => {
    const adapter = createAdapter("terminal-cli", { adapter: "terminal-cli", providers: {} });
    expect(adapter).toBeInstanceOf(TerminalCliAdapter);
  });

  it("createAdapter('agent-subtask', ...) resolved via the barrel returns an AgentSubtaskAdapter instance", () => {
    const adapter = createAdapter("agent-subtask", { adapter: "agent-subtask", providers: {} });
    expect(adapter).toBeInstanceOf(AgentSubtaskAdapter);
  });
});