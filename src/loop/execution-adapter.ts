export type ExecutionAdapterMode =
  | "agent-subtask"
  | "terminal-cli"
  | "ci"
  | "ssh"
  | "remote-worker"
  | "cross-agent";

export type ProviderCoupling =
  | "native-same-agent"
  | "shell-process"
  | "remote-worker"
  | "explicit-cross-agent";

export interface AdapterSelectionInput {
  explicitAdapter?: ExecutionAdapterMode;
  configuredAdapter?: ExecutionAdapterMode;
  insideAgentSession?: boolean;
  nativeSubtaskAvailable?: boolean;
  crossAgentConfigured?: boolean;
  tokenBudgetLow?: boolean;
}

export interface AdapterSelection {
  mode: ExecutionAdapterMode;
  autoDispatch: boolean;
  providerCoupling: ProviderCoupling;
  priority: number;
  warnings: string[];
  reason: string;
}

export interface CompactBootstrapInput {
  runId: string;
  clusterId: string;
  childId: string | null;
  stateFile: string;
  telemetryFile: string;
  currentStateSha: string;
  branch: string;
}

export interface CompactBootstrapState {
  run_id: string;
  cluster_id: string;
  child_id: string | null;
  state_file: string;
  telemetry_file: string;
  current_state_sha: string;
  branch: string;
  return_summary_contract: string[];
}

export interface ExecutionAdapterContract extends AdapterSelection {
  compact_bootstrap_state: CompactBootstrapState;
  dispatch_contract: {
    one_child_per_worker: true;
    parent_receives_compact_summary_only: true;
    child_transcript_retained_by_worker: true;
    updates_current_state_and_telemetry: true;
  };
  fallback_order: ExecutionAdapterMode[];
}

const FALLBACK_ORDER: ExecutionAdapterMode[] = [
  "agent-subtask",
  "terminal-cli",
  "ci",
  "ssh",
  "remote-worker",
  "cross-agent",
];

function fromConfigured(mode: ExecutionAdapterMode): AdapterSelection {
  switch (mode) {
    case "agent-subtask":
      return {
        mode,
        autoDispatch: true,
        providerCoupling: "native-same-agent",
        priority: 1,
        warnings: [],
        reason: "native same-agent subtask adapter configured",
      };
    case "terminal-cli":
      return {
        mode,
        autoDispatch: false,
        providerCoupling: "shell-process",
        priority: 2,
        warnings: [],
        reason: "terminal CLI worker adapter configured",
      };
    case "ci":
      return {
        mode,
        autoDispatch: false,
        providerCoupling: "remote-worker",
        priority: 3,
        warnings: [],
        reason: "CI worker adapter configured",
      };
    case "ssh":
    case "remote-worker":
      return {
        mode,
        autoDispatch: false,
        providerCoupling: "remote-worker",
        priority: 3,
        warnings: [],
        reason: "remote worker adapter configured",
      };
    case "cross-agent":
      return {
        mode,
        autoDispatch: true,
        providerCoupling: "explicit-cross-agent",
        priority: 4,
        warnings: [],
        reason: "cross-agent fallback explicitly configured",
      };
  }
}

export function selectExecutionAdapter(input: AdapterSelectionInput): AdapterSelection {
  const requested = input.explicitAdapter ?? input.configuredAdapter;
  const warnings: string[] = [];

  if (requested === "cross-agent" && !input.crossAgentConfigured && !input.tokenBudgetLow) {
    warnings.push("cross-agent fallback requires explicit configuration or low-token emergency");
    return {
      ...fromConfigured("terminal-cli"),
      warnings,
      reason: "cross-agent fallback denied; terminal CLI requires explicit external worker handoff",
    };
  }

  if (requested) {
    return fromConfigured(requested);
  }

  if (input.insideAgentSession && input.nativeSubtaskAvailable) {
    return {
      mode: "agent-subtask",
      autoDispatch: true,
      providerCoupling: "native-same-agent",
      priority: 1,
      warnings,
      reason: "native same-agent subtask dispatch is available",
    };
  }

  if (input.insideAgentSession && !input.nativeSubtaskAvailable) {
    warnings.push("native subtask dispatch unavailable; parent must not shell out to nested agent CLI by default");
    return {
      ...fromConfigured("terminal-cli"),
      autoDispatch: false,
      warnings,
      reason: "fallback requires external terminal worker or explicit adapter configuration",
    };
  }

  return fromConfigured("terminal-cli");
}

export function buildCompactBootstrapState(input: CompactBootstrapInput): CompactBootstrapState {
  return {
    run_id: input.runId,
    cluster_id: input.clusterId,
    child_id: input.childId,
    state_file: input.stateFile,
    telemetry_file: input.telemetryFile,
    current_state_sha: input.currentStateSha,
    branch: input.branch,
    return_summary_contract: [
      "child_id",
      "status",
      "commit_hash",
      "validation_summary",
      "next_action",
    ],
  };
}

export function buildExecutionAdapterContract(
  selection: AdapterSelection,
  compactBootstrapState: CompactBootstrapState,
): ExecutionAdapterContract {
  return {
    ...selection,
    compact_bootstrap_state: compactBootstrapState,
    dispatch_contract: {
      one_child_per_worker: true,
      parent_receives_compact_summary_only: true,
      child_transcript_retained_by_worker: true,
      updates_current_state_and_telemetry: true,
    },
    fallback_order: FALLBACK_ORDER,
  };
}
