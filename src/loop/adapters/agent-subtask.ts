/**
 * Agent-subtask adapter — dispatches a worker as a native agent subtask.
 *
 * In an environment that supports native subtask dispatch (e.g. Claude Code
 * with the TaskCreate tool), the parent invokes a subtask rather than spawning
 * a shell process. The contract is identical: one bootstrap packet in, one
 * compact return JSON out.
 *
 * When native dispatch is unavailable at runtime this adapter throws so the
 * caller can fall back to terminal-cli or surface a clear error.
 */

import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./types.js";

export class AgentSubtaskAdapter implements ExecutionAdapter {
  readonly name = 'agent-subtask';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async dispatch(_packet: BootstrapPacket, _options: DispatchOptions): Promise<DispatchResult> {
    // Native agent subtask dispatch is environment-specific (e.g. Claude Code
    // TaskCreate tool). This adapter stub signals that the caller must arrange
    // the actual dispatch through the host environment's API.
    //
    // Returning a structured result with exit_code 0 and a sentinel summary
    // allows the parent loop to treat this as an ADAPTER HANDOFF — the host
    // environment receives the bootstrap packet and continues execution of the
    // child worker outside the parent process.
    throw new Error(
      'AgentSubtaskAdapter.dispatch() must be overridden by the host environment. ' +
        'The host (e.g. Claude Code with TaskCreate) is responsible for spawning the ' +
        'worker subtask and returning a compact WorkerSummary JSON. ' +
        'If you are running in a plain terminal, use the terminal-cli adapter instead.'
    );
  }
}
