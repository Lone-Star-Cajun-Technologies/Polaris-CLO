import type {
  ExecutionRole,
  RoleProviderPolicy,
  WorkerCostTier,
  WorkerProviderCapability,
  WorkerProviderRouterPolicy,
  WorkerQuotaPolicy,
  WorkerRouterPolicyConfig,
  WorkerTaskType,
  WorkerTrustTier,
} from "../../config/schema.js";

export type RouterRejectionReason =
  | "role-disabled"
  | "not-in-policy"
  | "quota-exhausted"
  | "trust-too-low"
  | "capability-mismatch"
  | "cost-policy"
  | "no-slot";

export interface WorkerRouterCandidate {
  provider: string;
  configured: boolean;
  policy?: WorkerProviderRouterPolicy;
}

export interface WorkerRouterConstraints {
  minTrustTier?: WorkerTrustTier;
  maxCostTier?: WorkerCostTier;
  disallowedQuotaPolicies?: WorkerQuotaPolicy[];
  requiredCapabilities?: WorkerProviderCapability[];
}

export interface WorkerRouterRuntimeState {
  activeSlotsByProvider?: Record<string, number>;
  quotaAvailableByProvider?: Record<string, boolean>;
  attemptedProviders?: string[];
}

export interface WorkerRouterInput {
  role: ExecutionRole;
  taskType: WorkerTaskType;
  adapter: string;
  providerOverride?: string;
  providers: string[];
  rotation?: string[];
  rolePolicy?: RoleProviderPolicy;
  roleConfiguredProvider?: string;
  routerPolicy?: WorkerRouterPolicyConfig;
  constraints?: WorkerRouterConstraints;
  runtime?: WorkerRouterRuntimeState;
  compatibilityMode?: boolean;
}

export interface WorkerRouterCandidateScore {
  orderScore: number;
  trustScore: number;
  costScore: number;
  total: number;
}

export interface WorkerRouterCandidateDecision {
  provider: string;
  eligible: boolean;
  score: WorkerRouterCandidateScore;
  rejectionReasons: RouterRejectionReason[];
  evidence: {
    orderIndex: number;
    trustTier?: WorkerTrustTier;
    costTier?: WorkerCostTier;
    quotaPolicy?: WorkerQuotaPolicy;
    activeSlots: number;
    slotLimit?: number;
    policyMatched: boolean;
  };
}

export interface WorkerRouterDecision {
  selectedProvider?: string;
  selectedWorker: {
    role: ExecutionRole;
    taskType: WorkerTaskType;
  };
  mode: "direct-worker" | "delegated";
  selectionReason: string;
  exhaustedReason?: string;
  compatibilityMode: boolean;
  providersTried: string[];
  candidates: WorkerRouterCandidateDecision[];
}

