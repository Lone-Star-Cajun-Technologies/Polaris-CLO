import {
  getRunHealthReportPath,
  markBypassed,
  readRunHealthReport,
  isMedicGateSatisfied,
} from "../run-health/index.js";

export interface MedicGateOptions {
  runId: string;
  repoRoot: string;
  /** Reason supplied via CLI when requesting a policy bypass. */
  bypassReason?: string;
  /** Configured bypass policy for the Medic gate. */
  bypassPolicy?: "none" | "cli";
  /** When true, do not mutate the run-health report (e.g. during --dry-run). */
  dryRun?: boolean;
}

/**
 * Validates that a run with a run-health report either has a Medic decision or
 * an explicit, allowed policy bypass. Returns `null` when finalize may proceed;
 * returns a human-readable blocker string otherwise.
 *
 * Fails closed: a report that exists but lacks a Medic decision/bypass blocks
 * final commit, push, PR creation, and tracker update.
 */
export function validateMedicGate(options: MedicGateOptions): string | null {
  const { runId, repoRoot, bypassReason, bypassPolicy = "none", dryRun = false } = options;
  const reportPath = getRunHealthReportPath(runId, repoRoot);
  const report = readRunHealthReport(runId, repoRoot);

  // No report means no symptoms were recorded — gate does not apply.
  if (!report) return null;

  if (isMedicGateSatisfied(report)) return null;

  if (bypassReason) {
    if (bypassPolicy !== "cli") {
      return (
        `Run-health report at ${reportPath} requires Medic consultation, but a CLI bypass is not allowed ` +
        `by finalize.medic.bypassPolicy (current: "${bypassPolicy}").`
      );
    }

    if (!dryRun) {
      markBypassed(
        runId,
        {
          reason: bypassReason,
          bypassed_by: process.env.USER ?? process.env.LOGNAME ?? "operator",
          bypassed_at: new Date().toISOString(),
        },
        repoRoot,
      );
    }
    return null;
  }

  const bypassHint =
    bypassPolicy === "cli"
      ? `To bypass this gate, use --bypass-medic "<reason>".`
      : `Bypass is not enabled by finalize.medic.bypassPolicy (current: "${bypassPolicy}").`;

  return (
    `Run-health report at ${reportPath} has recorded symptoms and requires a Medic consultation decision ` +
    `(medic_consult.status "resolved" or "bypassed", or an explicit policy_bypass) before finalize can commit, push, ` +
    `create a PR, or update the tracker.\n${bypassHint}`
  );
}
