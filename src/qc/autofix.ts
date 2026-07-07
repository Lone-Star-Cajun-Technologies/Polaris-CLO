/**
 * QC auto-fix gating.
 *
 * Determines whether a normalized finding is allowed to attempt an unattended
 * auto-fix. Gating is intentionally conservative: auto-fix is allowed only for
 * explicitly eligible providers, low/medium severities, non-security categories,
 * clean branches, and fix modes that are known to be safe.
 */

import type { QcConfig, QcProviderConfig } from "../config/schema.js";
import type { QcFinding, QcSeverity } from "./types.js";
import { compareSeverity } from "./severity.js";

/** Fix modes considered safe for unattended application. */
export const QC_SAFE_FIX_MODES = [
  "refactor",
  "style",
  "format",
  "typo",
  "lint-fix",
  "apply-suggestion",
  "safe",
];

/** Security-sensitive categories that must never auto-fix. */
const SECURITY_CATEGORY_PATTERN = /security|secret|vulnerability|vuln|auth|crypto|injection|xss|csrf|sql/i;

export interface AutofixContext {
  /** Provider that emitted the finding. */
  provider?: string;
  /** Route name for per-route policy overrides. */
  routeName?: string;
  /** Whether the working branch is dirty. Auto-fix requires a clean branch. */
  branchDirty?: boolean;
}

function isSecurityCategory(category: string | undefined): boolean {
  if (!category) return false;
  return SECURITY_CATEGORY_PATTERN.test(category);
}

function providerConfig(config: QcConfig, provider: string | undefined): QcProviderConfig | undefined {
  if (!provider) return undefined;
  return config.providers?.[provider];
}

function isSafeFixMode(suggestedAction: string | undefined): boolean {
  if (!suggestedAction) return true;
  const normalized = suggestedAction.trim().toLowerCase();
  if (QC_SAFE_FIX_MODES.includes(normalized)) return true;
  // A provider may describe a safe fix with a sentence that starts with a safe mode keyword.
  return QC_SAFE_FIX_MODES.some((mode) => normalized.startsWith(mode));
}

/**
 * Check whether a finding may attempt an unattended auto-fix.
 *
 * Returns an object so callers can log why a fix was blocked.
 */
export function isAutofixEligible(
  finding: QcFinding,
  config: QcConfig,
  context: AutofixContext = {},
): { eligible: boolean; reason: string } {
  const globalPolicy = config.autoFix ?? "disabled";

  if (globalPolicy === "disabled") {
    return { eligible: false, reason: "auto-fix disabled globally" };
  }

  const routePolicy = context.routeName ? config.routes?.[context.routeName]?.autoFix : undefined;
  if (routePolicy === "disabled") {
    return { eligible: false, reason: "auto-fix disabled for route" };
  }

  const pCfg = providerConfig(config, context.provider);
  if (!pCfg?.autoFixEligible) {
    return { eligible: false, reason: "provider not auto-fix eligible" };
  }

  const maxAutofixSeverity: QcSeverity = "medium";
  if (compareSeverity(finding.severity, maxAutofixSeverity) > 0) {
    return { eligible: false, reason: `severity ${finding.severity} exceeds auto-fix threshold` };
  }

  if (isSecurityCategory(finding.category)) {
    return { eligible: false, reason: "security-sensitive finding" };
  }

  if (context.branchDirty) {
    return { eligible: false, reason: "branch has uncommitted changes" };
  }

  if (!finding.fixAvailable) {
    return { eligible: false, reason: "no fix available" };
  }

  if (!isSafeFixMode(finding.suggestedAction)) {
    return { eligible: false, reason: `fix mode "${finding.suggestedAction}" is not in safe list` };
  }

  if (globalPolicy === "dry-run") {
    return { eligible: true, reason: "dry-run mode: fix may be generated but not applied" };
  }

  return { eligible: true, reason: "auto-fix eligible" };
}
