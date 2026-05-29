/**
 * Compact worker prompt builder.
 *
 * Generates deterministic, size-bounded prompts for impl worker dispatch.
 * Replaces ad-hoc string construction in compileImplPacket with a structured
 * template that omits full issue bodies, repeated doctrine, and architecture
 * explanations — all of which inflate token cost without aiding implementation.
 *
 * Two modes:
 *   compact (default) — narrow single-repo children; structured template only.
 *   full             — cross-cutting or architectural children; may include
 *                      expanded issue context.
 *
 * Governance instructions (validation, commit, boundary, reporting) are always
 * preserved in both modes.
 */

import type { IssueContext } from "./worker-packet.js";
import type { LoopState } from "./checkpoint.js";

// ── Prompt mode ───────────────────────────────────────────────────────────────

export type WorkerPromptMode = 'compact' | 'full';

// ── Narrow-child heuristics ───────────────────────────────────────────────────

/**
 * Labels that mark a child as non-narrow (requires full context).
 * Checked against open_children_meta[childId].labels.
 */
const WIDE_LABELS = new Set([
  'cross-cutting',
  'high-risk',
  'parallel',
  'worker-isolation',
  'architectural',
]);

/**
 * Returns true when a child qualifies for compact dispatch.
 * A child is narrow when it has no wide labels and no explicit full-context flag.
 */
export function isNarrowChild(childId: string, state: LoopState): boolean {
  const meta = state.open_children_meta?.[childId];
  if (!meta) return true;
  const labels = meta.labels ?? [];
  for (const label of labels) {
    if (WIDE_LABELS.has(label)) return false;
  }
  return true;
}

/**
 * Selects the prompt mode for a given child.
 * - Returns 'compact' for narrow children (default).
 * - Returns 'full' when forced via override or when child is wide.
 */
export function selectPromptMode(
  childId: string,
  state: LoopState,
  override?: WorkerPromptMode,
): WorkerPromptMode {
  if (override) return override;
  return isNarrowChild(childId, state) ? 'compact' : 'full';
}

// ── Prompt inputs ─────────────────────────────────────────────────────────────

export interface WorkerPromptInput {
  issueId: string;
  title: string;
  worktree: string;
  branch: string;
  goal: string;
  scopeTouch: string[];
  scopeAvoid: string[];
  acceptanceCriteria: string[];
  existingHelpers: string[];
  validationCommands: string[];
  commitFormat: string;
  stateFile: string;
  telemetryFile: string;
  /** Expanded issue context — included only in full mode. */
  issueContext?: IssueContext;
  mode: WorkerPromptMode;
}

// ── Prompt metrics ────────────────────────────────────────────────────────────

export interface WorkerPromptMetrics {
  mode: WorkerPromptMode;
  /** Rough character count of the rendered prompt. */
  char_count: number;
  /** Rough token estimate (chars / 4, rounded). */
  estimated_tokens: number;
}

export interface WorkerPromptResult {
  prompt: string;
  metrics: WorkerPromptMetrics;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a compact or full worker dispatch prompt.
 *
 * The compact template carries only what the worker needs to implement:
 * identity, location, goal, scope, acceptance criteria, helpers, validation,
 * and reporting format. It intentionally omits full issue bodies, cluster JSON,
 * repeated doctrine, and architecture explanations.
 *
 * Full mode appends expanded issue context after the compact body.
 * Governance instructions are always present in both modes.
 */
export function buildWorkerPrompt(input: WorkerPromptInput): WorkerPromptResult {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`Issue: ${input.issueId} — ${input.title}`);
  lines.push(`Worktree: ${input.worktree}`);
  lines.push(`Branch: ${input.branch}`);
  lines.push('');

  // ── Goal ──────────────────────────────────────────────────────────────────
  lines.push('## Goal');
  lines.push(input.goal.trim());
  lines.push('');

  // ── Scope ─────────────────────────────────────────────────────────────────
  lines.push('## Scope');
  if (input.scopeTouch.length > 0) {
    lines.push('Touch only:');
    for (const s of input.scopeTouch) lines.push(`- ${s}`);
  }
  if (input.scopeAvoid.length > 0) {
    lines.push('Do not touch:');
    for (const s of input.scopeAvoid) lines.push(`- ${s}`);
  }
  lines.push('');

  // ── Acceptance Criteria ───────────────────────────────────────────────────
  lines.push('## Acceptance Criteria');
  for (const ac of input.acceptanceCriteria) lines.push(`- ${ac}`);
  lines.push('');

  // ── Existing Helpers ──────────────────────────────────────────────────────
  if (input.existingHelpers.length > 0) {
    lines.push('## Existing Helpers');
    for (const h of input.existingHelpers) lines.push(`- ${h}`);
    lines.push('');
  }

  // ── Validation ────────────────────────────────────────────────────────────
  lines.push('## Validation');
  for (const cmd of input.validationCommands) lines.push(`- ${cmd}`);
  lines.push('');

  // ── Commit ────────────────────────────────────────────────────────────────
  lines.push('## Commit');
  lines.push(input.commitFormat);
  lines.push('');

  // ── State + telemetry (governance — always present) ───────────────────────
  lines.push('## Governance');
  lines.push(`- Update ${input.stateFile}: move "${input.issueId}" from open_children to completed_children.`);
  lines.push(`- Append a telemetry event to ${input.telemetryFile}.`);
  lines.push('');

  // ── Worker Heartbeat Telemetry (observability — always present) ────────────
  lines.push('## Worker Progress Telemetry (MANDATORY)');
  lines.push('The parent CANNOT see your work. You MUST emit heartbeat events so the parent knows you are alive and making progress.');
  lines.push('');
  lines.push(`After EVERY step, append a JSONL event to ${input.telemetryFile}:`);
  lines.push('```jsonl');
  lines.push(`{"event":"worker-heartbeat","run_id":"<from packet>","child_id":"${input.issueId}","step_cursor":"<current step>","timestamp":"<ISO8601>","progress_pct":<0-100>,"files_changed":<count>,"current_file":"<file being edited>"}`);
  lines.push('```');
  lines.push('');
  lines.push('Required heartbeat points:');
  lines.push('  1. Immediately after reading this packet (step_cursor: "start")');
  lines.push('  2. After verifying state file (step_cursor: "verify")');
  lines.push('  3. After EACH file edit (step_cursor: "implement")');
  lines.push('  4. After running validation (step_cursor: "validate")');
  lines.push('  5. After creating commit (step_cursor: "commit")');
  lines.push('  6. Before terminating (step_cursor: "complete" or "failed")');
  lines.push('');
  lines.push('If heartbeats stop, the parent will assume you crashed and may dispatch a replacement worker.');
  lines.push('');

  // ── Route cognition delta (always present) ────────────────────────────────
  lines.push('## Route Cognition Delta');
  lines.push('After implementation, apply route-local cognition delta — only if something materially changed.');
  lines.push('');
  lines.push('**POLARIS.md** — update only when ALL of the following are true:');
  lines.push('  - You touched a file in that folder (not a distant folder).');
  lines.push('  - The change materially affects: folder responsibilities, commands/workflows,');
  lines.push('    execution constraints, ownership/routing, or operational behavior.');
  lines.push('  - The current POLARIS.md content is actually wrong or incomplete as a result.');
  lines.push('  DO NOT update POLARIS.md for: formatting fixes, comment changes, tiny refactors,');
  lines.push('  internal implementation details, or any change that leaves the operational guidance');
  lines.push('  still accurate. When in doubt, do not update.');
  lines.push('');
  lines.push('**SUMMARY.md** — update only when: linked docs/specs changed, canon relationships');
  lines.push('  changed, architecture meaning changed, or doctrine/spec linkage changed.');
  lines.push('  SUMMARY.md is informational only. Do not create it if missing — that is a hint for');
  lines.push('  operators, not a task for workers. Keep it short. Never add operational doctrine.');
  lines.push('');
  lines.push('**Never** scan unrelated folders. **Never** regenerate all route docs.');
  lines.push('If no material change occurred, skip this section entirely.');
  lines.push('');

  // ── Report Back ───────────────────────────────────────────────────────────
  lines.push('## Report Back');
  lines.push('- files changed');
  lines.push('- validation results');
  lines.push('- commit hash');
  lines.push('- blockers');
  lines.push('');

  // ── Termination (governance — always present) ─────────────────────────────
  lines.push('TERMINATE SESSION IMMEDIATELY. Do not select or execute the next child.');

  // ── Full mode: append expanded context ───────────────────────────────────
  if (input.mode === 'full' && input.issueContext) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Expanded Issue Context');
    lines.push(`**${input.issueContext.id}**: ${input.issueContext.title}`);
    if (input.issueContext.key_requirements.length > 0) {
      lines.push('');
      lines.push('Key requirements:');
      for (const [i, r] of input.issueContext.key_requirements.entries()) {
        lines.push(`${i + 1}. ${r}`);
      }
    }
  }

  const prompt = lines.join('\n');
  const charCount = prompt.length;
  return {
    prompt,
    metrics: {
      mode: input.mode,
      char_count: charCount,
      estimated_tokens: Math.round(charCount / 4),
    },
  };
}

// ── Convenience: build from WorkerPacket inputs ───────────────────────────────

export interface BuildPromptFromPacketInput {
  issueId: string;
  title: string;
  worktree: string;
  branch: string;
  stateFile: string;
  telemetryFile: string;
  issueContext?: IssueContext;
  allowedScope?: string[];
  validationCommands?: string[];
  mode: WorkerPromptMode;
}

/**
 * Build a worker prompt from the same inputs used by compileImplPacket.
 * Derives goal, scope, acceptance criteria, and helpers from issue context.
 */
export function buildPromptFromPacketInput(
  input: BuildPromptFromPacketInput,
): WorkerPromptResult {
  const requirements = input.issueContext?.key_requirements ?? [];

  return buildWorkerPrompt({
    issueId: input.issueId,
    title: input.title,
    worktree: input.worktree,
    branch: input.branch,
    goal: requirements.length > 0
      ? requirements[0]
      : `Implement ${input.issueId}: "${input.title}".`,
    scopeTouch: input.allowedScope ?? [],
    scopeAvoid: [],
    acceptanceCriteria: requirements.length > 1 ? requirements.slice(1) : requirements,
    existingHelpers: [],
    validationCommands: input.validationCommands ?? [],
    commitFormat: `[${input.issueId}] ${input.title}`,
    stateFile: input.stateFile,
    telemetryFile: input.telemetryFile,
    issueContext: input.issueContext,
    mode: input.mode,
  });
}
