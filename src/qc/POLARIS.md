# src/qc

## Purpose

The QC subsystem is the provider-agnostic Quality Control layer for Polaris. It invokes external reviewer providers at governed lifecycle triggers, parses and normalizes their output into Polaris-native findings, applies severity, attribution, auto-fix, and repair routing policy, and persists durable cluster-scoped QC artifacts. It does not implement worker dispatch or cluster delivery.

**Domain:** quality-control  
**Route:** src/qc

## What belongs here

- `orchestration.ts` — `runQcAtTrigger()`: invokes active providers, collects outputs, runs the repair loop, and returns aggregate policy action; owns repair round state transitions.
- `provider.ts` — `IQcProvider`, `QcReviewScope`, `QcProviderOutput`, `QcProviderRegistry` interfaces and base contracts.
- `registry.ts` — `QcProviderRegistry` singleton; registers concrete provider adapters.
- `providers/` — one file per provider adapter (e.g., `coderabbit.ts`); each adapter parses provider-specific output into `QcFinding[]`.
- `types.ts` — normalized `QcFinding`, `QcResult`, `QcProviderFailure`, `QcRepairPacket`, `QcRepairRound`, `QcRepairLoopState`, attribution, status, severity, and routing decision types.
- `schemas.ts` — Zod/JSON schema definitions for all QC artifacts.
- `policy.ts` — severity policy, auto-fix eligibility, and delivery blocking decisions.
- `attribution.ts` — evidence-based finding attribution to children (commit-line-match, changed-file-owner, child-scope-match, etc.).
- `severity.ts` — severity normalization and provider-label mapping.
- `routing.ts` — repair routing decisions (original-worker, repair-worker, follow-up, operator-review, medic).
- `runner.ts` — provider execution wrapper; classifies non-finding failures into `QcProviderFailure`.
- `autofix.ts` — auto-fix eligibility gating and application hooks.
- `artifacts.ts` — QC result artifact read/write helpers (cluster-scoped, atomic).
- `triggers.ts` — trigger-level policy (pr, completed-cluster, child).
- `security-category.ts` — security/auth/data-loss category constants for grouping guards.
- `index.ts` — public re-exports.
- `*.test.ts` — unit and integration tests.

## What does not belong here

- Worker dispatch and Worker Router decisions — belongs in `src/loop/dispatch.ts` and `src/loop/router/`.
- PR creation, push, or tracker closeout — belongs in `src/finalize/`.
- Cluster state reads/writes — belongs in `src/cluster-state/` (QC writes artifacts; cluster-state stores pointers).
- SOL scoring and proposal routing — belongs in `src/autoresearch/`.
- Config loading and schema validation — belongs in `src/config/`.

## Editing rules

- QC providers are external critics, not worker providers. Providers must never be dispatched through the Worker Router; they are invoked directly by `runner.ts`.
- Provider execution failures (`timeout`, `rate-limited`, `auth-failure`, `command-not-found`, `nonzero-exit`, `parse-failed`, `empty-output`, `unusable-output`, `unsupported-mode`, `unavailable-provider`) are classified as `QcProviderFailure`, not as findings. `unusable-output` covers provider payloads (e.g. progress/status/heartbeat/complete records) that parse successfully but contain no actionable finding — no `file`/`path` plus `message`/`title` fields. All failures must produce telemetry.
- Repair workers that address QC findings are dispatched by `src/loop/dispatch.ts` with `worker_role: repair`. `src/qc/` compiles the repair packet manifest; it does not dispatch workers.
- Repair packet manifests are written to `.polaris/clusters/<cluster-id>/qc/repair-rounds/<round>/repair-packets.json`.
- Max repair rounds is `2` by default, overridable by `polaris.config.json → qc.maxRepairRounds`. The loop must stop when `round > maxRepairRounds`.
- A finding may be marked `repaired` only after a post-repair QC run or explicit validation evidence from the repair worker's result packet.
- Grouping rules for repair packets: group by file + root-cause/category when ranges overlap; do not mix security/auth/data-loss/migration/governance findings with unrelated work.
- Parallelism is governed by `parallel_group`, `conflicts_with`, and scope overlap. Do not mark packets as parallel-safe if `allowed_scope` sets overlap or either touches shared governance/config files.
- All QC artifacts written to `.polaris/clusters/<cluster-id>/qc/` must use atomic writes. Never call `fs.writeFile()` directly on artifact paths.
- The telemetry event catalog for the repair loop is defined in `smartdocs/specs/active/quality-control-architecture.md §8.9`. Emit events from `orchestration.ts` and `runner.ts`; do not emit them from individual provider adapters.

## Provider config model

Extend `QcProviderConfig` (in `src/config/schema.ts`) to support:

```ts
interface QcProviderExecutionConfig {
  name: string;
  mode: "local" | "pr" | "metrics-import";
  command?: string;
  args?: string[];
  outputFormat?: "coderabbit" | "pr-agent" | "generic-json" | "jsonl" | "markdown";
  parser?: string;
  trigger?: "pr" | "completed-cluster" | "child";
  capabilities?: QcProviderCapability[];
  autoFixEligible?: boolean;
  timeoutMs?: number;
  rateLimitPolicy?: "fallback" | "block" | "follow-up" | "skip";
  failurePolicy?: "fallback" | "block" | "follow-up" | "skip";
  primary?: boolean;
  fallback?: string[];
  severityMapping?: Record<string, QcSeverity>;
}
```

## Repair loop state machine

States (managed by `orchestration.ts`):

`qc_review_requested` → `qc_provider_attempted` → `qc_results_normalized` → `repair_packets_compiled` → `repair_packets_dispatched` → `repair_results_collected` → `qc_rerun_requested` → (loop) or terminal state

Terminal states (`QcRepairLoopOutcome` in `src/loop/checkpoint.ts`): `pass`, `no-repairable`, `max-rounds`, `all-providers-failed`, `operator-review`, `medic-referral`, `qc-disabled`. These are the exact string literals stored in `state.qc_repair_loop.terminal_outcome` and `ClusterState.qc_repair_outcome`; finalize's repair-loop gate (`src/finalize/index.ts`) matches against them directly.

See `smartdocs/specs/active/quality-control-architecture.md §8.9` for the telemetry-aligned terminal outcome catalog that matches these values (§8.6–8.7 predate the implemented naming).

## Artifact paths

- QC run result: `.polaris/clusters/<cluster-id>/qc/<qc-run-id>.json`
- Raw provider output: `.polaris/clusters/<cluster-id>/qc/<qc-run-id>-raw.<ext>`
- Repair packet manifest: `.polaris/clusters/<cluster-id>/qc/repair-rounds/<round>/repair-packets.json`

## Read before editing

- `smartdocs/specs/active/quality-control-architecture.md` — full architecture spec including repair loop contract (§8).
- `smartdocs/architecture/quality-control-lifecycle.md` — lifecycle placement and operational boundaries.
- `smartdocs/raw/analysis/pol-500-provider-agnostic-qc-repair-loop-analysis.md` — source analysis for the repair loop.
- `src/config/schema.ts` — QC provider config schema.
- `src/cluster-state/types.ts` — `ClusterState.qc_runs` pointer format.

## Related routes

- `polaris.qc` — all files in this directory
- `src/loop/dispatch.ts` — dispatches repair workers (not QC providers)
- `src/cluster-state/` — stores QC run pointers and round state
- `src/finalize/` — reads QC artifacts for delivery gating
- `src/autoresearch/` — reads QC artifacts for SOL scoring
