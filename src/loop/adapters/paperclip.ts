import type { ExecutionConfig } from "../../config/schema.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./types.js";

/**
 * Stub pending LSC-22 (Paperclip adapter transport). Wires the "paperclip"
 * execution mode through the registry/parent/dispatch/confirmed-continuation
 * paths per LSC-19 plan section 3 (LSC-23). `dispatch()` fails closed with
 * `pre_dispatch_failure: true` — an harmless no-op for callers — until the
 * real HTTP transport (create/poll/reconcile against the Paperclip API,
 * per LSC-22) replaces this file. Do not add a second `paperclip.ts`;
 * extend this one.
 */
export class PaperclipAdapter implements ExecutionAdapter {
  readonly name = "paperclip";

  constructor(private readonly config: ExecutionConfig) {}

  // eslint-disable-next-line no-unused-vars
  async dispatch(_packet: BootstrapPacket, _options: DispatchOptions): Promise<DispatchResult> {
    void this.config;
    return {
      exit_code: 1,
      provider_used: "paperclip",
      command_run: "",
      pre_dispatch_failure: true,
      failure_origin: "provider-launch",
      failure_category: "provider-unavailable",
      fallback_eligible: false,
      summary: "Paperclip adapter transport not yet implemented (pending LSC-22).",
    };
  }
}
