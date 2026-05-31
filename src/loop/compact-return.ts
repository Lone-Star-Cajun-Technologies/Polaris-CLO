/**
 * CompactReturn — the structured summary a worker writes to stdout before exiting.
 *
 * The parent loop parses this to determine how to advance cluster state.
 * Workers MUST write exactly one JSON line (the CompactReturn) as the last
 * line of stdout and then exit immediately — no continuation to the next child.
 */

export interface CompactReturn {
  /** Linear ID of the child that was executed. */
  child_id: string;
  /** Execution outcome. */
  status: 'done' | 'failed' | 'blocked';
  /** 7-char git commit hash produced during this child, or null if none was made. */
  commit: string | null;
  /** Result of the child-level validation step. */
  validation: 'passed' | 'failed' | 'skipped';
  /** Whether the Linear tracker was updated (child status set to Done). */
  tracker_updated: boolean;
  /** Whether current-state.json was updated before exit. */
  state_updated: boolean;
  /** Whether a telemetry JSONL event was appended before exit. */
  telemetry_updated: boolean;
  /** Recommended next action for the parent loop or operator. */
  next_recommended_action: 'continue' | 'stop' | 'investigate';
  /** Optional results from the child execution. */
  result_data?: Record<string, unknown>;
}

/**
 * Validate an unknown value against the CompactReturn schema.
 * Returns an array of error strings; empty means valid.
 */
export function validateCompactReturn(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['CompactReturn must be a JSON object'];
  }
  const r = value as Record<string, unknown>;

  if (typeof r['child_id'] !== 'string' || !r['child_id']) {
    errors.push('missing or empty child_id');
  }
  if (r['status'] !== 'done' && r['status'] !== 'failed' && r['status'] !== 'blocked') {
    errors.push('status must be "done", "failed", or "blocked"');
  }
  if (r['commit'] !== null && typeof r['commit'] !== 'string') {
    errors.push('commit must be a string or null');
  }
  if (r['validation'] !== 'passed' && r['validation'] !== 'failed' && r['validation'] !== 'skipped') {
    errors.push('validation must be "passed", "failed", or "skipped"');
  }
  if (typeof r['tracker_updated'] !== 'boolean') {
    errors.push('tracker_updated must be a boolean');
  }
  if (typeof r['state_updated'] !== 'boolean') {
    errors.push('state_updated must be a boolean');
  }
  if (typeof r['telemetry_updated'] !== 'boolean') {
    errors.push('telemetry_updated must be a boolean');
  }
  if (
    r['next_recommended_action'] !== 'continue' &&
    r['next_recommended_action'] !== 'stop' &&
    r['next_recommended_action'] !== 'investigate'
  ) {
    errors.push('next_recommended_action must be "continue", "stop", or "investigate"');
  }
  if ('result_data' in r && r['result_data'] !== undefined) {
    if (typeof r['result_data'] !== 'object' || r['result_data'] === null || Array.isArray(r['result_data'])) {
      errors.push('result_data must be an object');
    }
  }

  return errors;
}
