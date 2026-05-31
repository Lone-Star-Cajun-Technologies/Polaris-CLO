/**
 * Compact packet sent to the external worker at the start of each dispatch.
 * The worker reads this to know which child to execute and where to write state/telemetry.
 *
 * Delivery channels (all provided simultaneously):
 *   - stdin (JSON)
 *   - POLARIS_PACKET_FILE env var (path to a temp file with the same JSON)
 *   - POLARIS_PACKET_JSON env var (raw JSON string)
 *   - Individual fields as POLARIS_* env vars
 *
 * When schema_version is '2.0', the packet is a compiled WorkerPacket (see
 * src/loop/worker-packet.ts) containing pre-baked instructions. Adapters SHOULD
 * check for the WorkerPacket shape and use compiled instructions when available.
 */
export interface BootstrapPacket {
  schema_version: string;
  run_id: string;
  cluster_id: string;
  /** Linear ID of the child task the worker must execute — exactly one. */
  active_child: string;
  /** Absolute path to current-state.json. Worker must update this when done. */
  state_file: string;
  /** Absolute path to telemetry JSONL file. Worker appends one entry per dispatch. */
  telemetry_file: string;
  /** Dispatch record ID, used in worker-acknowledged telemetry. */
  dispatch_id?: string;
  /** Worker identity token, used in worker-acknowledged telemetry. */
  worker_id?: string;
  /** Arbitrary additional context the parent wants to pass to the worker. */
  context?: Record<string, unknown>;
}

/**
 * Worker summary returned via stdout (last line must be valid JSON or plain text).
 * `status` includes both 'error' (generic adapter error) and 'failed' (CompactReturn
 * terminal failure) so the parent can handle both without an unexpected-status halt.
 */
export interface WorkerSummary {
  active_child: string;
  status: 'done' | 'blocked' | 'error' | 'failed';
  message?: string;
  [key: string]: unknown;
}

export interface DispatchOptions {
  /** Provider name to use (must exist in config.execution.providers). */
  provider: string;
  /** If true, print the exact command that would run and return without executing. */
  dryRun?: boolean;
}

export interface DispatchResult {
  exit_code: number;
  provider_used: string;
  /** The full shell-quoted command string that was (or would be) run. */
  command_run: string;
  /** Parsed or raw summary from worker stdout. */
  summary?: string;
  stdout?: string;
  stderr?: string;
}

export interface ExecutionAdapter {
  readonly name: string;
  dispatch(packet: BootstrapPacket, options: DispatchOptions): Promise<DispatchResult>;
}
