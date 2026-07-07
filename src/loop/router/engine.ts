import type {
  ExecutionRole,
  WorkerCostTier,
  WorkerProviderCapability,
  WorkerQuotaPolicy,
  WorkerTaskType,
  WorkerTrustTier,
} from "../../config/schema.js";
import type {
  RouterRejectionReason,
  WorkerRouterCandidateDecision,
  WorkerRouterDecision,
  WorkerRouterInput,
} from "./types.js";

const TRUST_RANK: Record<WorkerTrustTier, number> = {
  sandbox: 0,
  standard: 1,
  trusted: 2,
};

const COST_RANK: Record<WorkerCostTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function defaultCapabilitiesForTask(taskType: WorkerTaskType): WorkerProviderCapability[] {
  switch (taskType) {
    case "startup":
      return ["orchestration"];
    case "analyze":
      return ["analysis"];
    case "impl":
      return ["implementation"];
    case "repair":
      return ["repair"];
    case "docs":
      return ["docs"];
    case "finalize":
      return ["finalization"];
    default:
      return [];
  }
}

function orderedProviders(input: WorkerRouterInput): string[] {
  if (input.providerOverride) {
    return [input.providerOverride];
  }
  const roleProviders = input.rolePolicy?.providers ?? [];
  const rotation = input.rotation ?? [];
  if (input.compatibilityMode !== false) {
    if (roleProviders.length > 0) {
      const filteredRotation = rotation.filter((provider) => roleProviders.includes(provider));
      if (filteredRotation.length > 0) {
        return filteredRotation;
      }
      const configuredProviders = new Set(input.providers);
      return roleProviders.filter((provider) => configuredProviders.has(provider));
    }
    if (input.roleConfiguredProvider) {
      return [input.roleConfiguredProvider];
    }
    if (rotation.length > 0) {
      return rotation;
    }
    return input.providers;
  }

  const preferred = rotation.length > 0 ? rotation : input.providers;
  if (roleProviders.length === 0) {
    return preferred;
  }
  const configuredAndAllowed = new Set(roleProviders.filter((provider) => input.providers.includes(provider)));
  const ordered = preferred.filter((provider) => configuredAndAllowed.has(provider));
  if (ordered.length > 0) {
    return ordered;
  }
  return roleProviders.filter((provider) => input.providers.includes(provider));
}

function compatibilitySelectionReason(input: WorkerRouterInput, selectedProvider?: string): string {
  if (input.providerOverride) return "cli-provider-override";
  if (!selectedProvider) return "delegated-no-provider";
  const roleProviders = input.rolePolicy?.providers ?? [];
  if (roleProviders.length > 0) {
    const rotation = input.rotation ?? [];
    if (rotation.filter((provider) => roleProviders.includes(provider))[0] === selectedProvider) {
      return "policy-filtered-rotation";
    }
    return "role-policy";
  }
  if (input.roleConfiguredProvider === selectedProvider) return "role-config";
  if ((input.rotation ?? [])[0] === selectedProvider) return "config-rotation";
  return "config-first-provider";
}

function compatibilityExhaustedReason(input: WorkerRouterInput): string {
  const roleProviders = input.rolePolicy?.providers ?? [];
  if (roleProviders.length > 0) return "role-policy-no-configured-provider";
  return "no-configured-provider";
}

function topRejectionReason(candidates: WorkerRouterCandidateDecision[]): RouterRejectionReason | undefined {
  const orderedReasons: RouterRejectionReason[] = [
    "role-disabled",
    "not-in-policy",
    "quota-exhausted",
    "trust-too-low",
    "capability-mismatch",
    "cost-policy",
    "no-slot",
  ];
  for (const reason of orderedReasons) {
    if (candidates.some((candidate) => candidate.rejectionReasons.includes(reason))) {
      return reason;
    }
  }
  return undefined;
}

export function decideWorkerRoute(input: WorkerRouterInput): WorkerRouterDecision {
  const compatibilityMode = input.compatibilityMode !== false;
  const providerRegistry = input.routerPolicy?.providerRegistry ?? {};
  const roleProviders = input.rolePolicy?.providers ?? [];
  const requiredCapabilities = input.constraints?.requiredCapabilities ?? defaultCapabilitiesForTask(input.taskType);
  const ordered = orderedProviders(input);
  const activeSlotsByProvider = input.runtime?.activeSlotsByProvider ?? {};
  const quotaAvailableByProvider = input.runtime?.quotaAvailableByProvider ?? {};
  const globalSlotLimit = input.routerPolicy?.defaultWorkerPool?.maxActiveSlots;
  const candidates: WorkerRouterCandidateDecision[] = [];

  if (roleProviders.length === 0 && input.rolePolicy) {
    return {
      selectedProvider: undefined,
      selectedWorker: { role: input.role, taskType: input.taskType },
      mode: "delegated",
      selectionReason: compatibilityMode ? "delegated-no-provider" : "router-role-disabled",
      exhaustedReason: "role-disabled",
      compatibilityMode,
      providersTried: [],
      candidates: [],
    };
  }

  for (const [orderIndex, provider] of ordered.entries()) {
    const policy = providerRegistry[provider];
    const rejectionReasons: RouterRejectionReason[] = [];
    const eligibleRoleSet = new Set(policy?.eligibleRoles ?? []);
    const policyMatched = !policy || eligibleRoleSet.size === 0 || eligibleRoleSet.has(input.role as ExecutionRole);
    if (!policyMatched) {
      rejectionReasons.push("role-disabled");
    }
    if (roleProviders.length > 0 && !roleProviders.includes(provider)) {
      rejectionReasons.push("not-in-policy");
    }

    const capabilitySet = new Set(policy?.capabilities ?? []);
    const allowedTaskSet = new Set(policy?.taskTypes ?? []);
    if (
      (capabilitySet.size > 0 && requiredCapabilities.some((capability) => !capabilitySet.has(capability))) ||
      (allowedTaskSet.size > 0 && !allowedTaskSet.has(input.taskType))
    ) {
      rejectionReasons.push("capability-mismatch");
    }

    const providerTrust = policy?.trustTier;
    const minTrust = input.constraints?.minTrustTier;
    if (providerTrust && minTrust && TRUST_RANK[providerTrust] < TRUST_RANK[minTrust]) {
      rejectionReasons.push("trust-too-low");
    }

    const providerCost = policy?.costTier;
    const maxCost = input.constraints?.maxCostTier;
    if (providerCost && maxCost && COST_RANK[providerCost] > COST_RANK[maxCost]) {
      rejectionReasons.push("cost-policy");
    }

    const disallowedQuota = new Set(input.constraints?.disallowedQuotaPolicies ?? []);
    if (policy?.quotaPolicy && disallowedQuota.has(policy.quotaPolicy as WorkerQuotaPolicy)) {
      rejectionReasons.push("cost-policy");
    }
    if (policy?.quotaPolicy && quotaAvailableByProvider[provider] === false) {
      rejectionReasons.push("quota-exhausted");
    }

    const activeSlots = activeSlotsByProvider[provider] ?? 0;
    const providerSlotLimit = policy?.maxActiveSlots;
    if (providerSlotLimit !== undefined && activeSlots >= providerSlotLimit) {
      rejectionReasons.push("no-slot");
    }
    if (globalSlotLimit !== undefined && activeSlots >= globalSlotLimit) {
      rejectionReasons.push("no-slot");
    }

    const score = {
      orderScore: Math.max(0, 100 - orderIndex),
      trustScore: providerTrust ? TRUST_RANK[providerTrust] * 1_000 : 0,
      costScore: providerCost ? (3 - COST_RANK[providerCost]) * 10 : 0,
      total: 0,
    };
    score.total = score.orderScore + score.trustScore + score.costScore;

    candidates.push({
      provider,
      eligible: rejectionReasons.length === 0,
      score,
      rejectionReasons,
      evidence: {
        orderIndex,
        trustTier: providerTrust,
        costTier: providerCost,
        quotaPolicy: policy?.quotaPolicy,
        activeSlots,
        slotLimit: providerSlotLimit ?? globalSlotLimit,
        policyMatched,
      },
    });
  }

  const eligibleCandidates = candidates.filter((candidate) => candidate.eligible);
  const selected = eligibleCandidates
    .slice()
    .sort((a, b) => {
      if (a.score.total !== b.score.total) return b.score.total - a.score.total;
      if (a.evidence.orderIndex !== b.evidence.orderIndex) return a.evidence.orderIndex - b.evidence.orderIndex;
      return a.provider.localeCompare(b.provider);
    })[0];
  const selectedProvider = selected?.provider;

  if (!selectedProvider) {
    const rejection = topRejectionReason(candidates);
    const exhaustedReason = rejection ?? (compatibilityMode ? compatibilityExhaustedReason(input) : "no-eligible-provider");
    const selectionReason = compatibilityMode ? "delegated-no-provider" : "router-no-eligible-provider";
    return {
      selectedProvider: undefined,
      selectedWorker: { role: input.role, taskType: input.taskType },
      mode: "delegated",
      selectionReason,
      exhaustedReason,
      compatibilityMode,
      providersTried: ordered,
      candidates,
    };
  }

  return {
    selectedProvider,
    selectedWorker: { role: input.role, taskType: input.taskType },
    mode: "direct-worker",
    selectionReason: compatibilityMode ? compatibilitySelectionReason(input, selectedProvider) : "policy-router",
    compatibilityMode,
    providersTried: ordered,
    candidates,
  };
}
