/**
 * QC trigger selection logic.
 *
 * Decides which lifecycle trigger a configured provider participates in, and
 * whether child-level QC should be selected for a given dispatch.
 */

import type { QcConfig, QcProviderConfig, QcTriggerMode } from "../config/schema.js";

/** High-risk scope patterns that make a child eligible for child-level QC. */
const HIGH_RISK_SCOPE_PATTERNS = [
  /src\/auth/i,
  /src\/security/i,
  /src\/payments/i,
  /src\/crypto/i,
  /src\/db/i,
  /src\/database/i,
  /src\/api/i,
];

/**
 * Derive the effective trigger for a provider.
 * Falls back to a sensible default derived from the provider mode, then the
 * cluster-wide default trigger.
 */
export function effectiveProviderTrigger(
  provider: QcProviderConfig,
  defaultTrigger: QcTriggerMode,
): QcTriggerMode {
  if (provider.trigger) return provider.trigger;

  switch (provider.mode) {
    case "pr":
      return "pr";
    case "local":
      return "completed-cluster";
    case "metrics-import":
      return "completed-cluster";
    default:
      return defaultTrigger;
  }
}

/**
 * Return configured providers that participate in the given trigger.
 */
export function activeProvidersForTrigger(
  config: QcConfig | undefined,
  trigger: QcTriggerMode,
): Array<[string, QcProviderConfig]> {
  if (!config?.enabled) return [];

  const defaultTrigger = config.defaultTrigger ?? "completed-cluster";
  return Object.entries(config.providers ?? {}).filter(([, provider]) => {
    return effectiveProviderTrigger(provider, defaultTrigger) === trigger;
  });
}

/**
 * Returns true when a scope touches files generally considered high-risk.
 */
export function isHighRiskScope(scope: string[]): boolean {
  return scope.some((pattern) =>
    HIGH_RISK_SCOPE_PATTERNS.some((re) => re.test(pattern)),
  );
}

/**
 * Decide whether child-level QC should be selected for a child.
 *
 * Child-level QC is intentionally opt-in. It is selected only when:
 *   - QC is enabled and at least one provider is configured for the child trigger.
 *   - A route policy explicitly enables child-level QC for this route, OR
 *   - The child is explicitly tagged with "qc-child", OR
 *   - The child's scope contains high-risk paths (auth, security, payments, etc.).
 */
export function isChildQcSelected(
  config: QcConfig | undefined,
  childId: string,
  allowedScope: string[],
  labels: string[] | undefined,
  routeName?: string,
): boolean {
  if (!config?.enabled) return false;

  const childProviders = activeProvidersForTrigger(config, "child");
  if (childProviders.length === 0) return false;

  const routePolicy = routeName ? config.routes?.[routeName] : undefined;
  if (routePolicy?.childLevel) return true;
  if (labels?.includes("qc-child")) return true;
  if (isHighRiskScope(allowedScope)) return true;

  return false;
}

/**
 * Select the QC trigger for a child dispatch.
 * Returns "child" when child-level QC is selected, otherwise null.
 */
export function selectChildQcTrigger(
  config: QcConfig | undefined,
  childId: string,
  allowedScope: string[],
  labels?: string[],
  routeName?: string,
): QcTriggerMode | null {
  return isChildQcSelected(config, childId, allowedScope, labels, routeName)
    ? "child"
    : null;
}
