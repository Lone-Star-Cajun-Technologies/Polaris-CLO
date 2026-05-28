import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_LEDGER_PATH = ".polaris/runs/ledger.jsonl";

export type LedgerRunType =
  | "analyze"
  | "implement"
  | "absorb"
  | "docs-ingest"
  | "docs-bootstrap"
  | "audit"
  | "finalize";

export type LedgerStatus =
  | "ready"
  | "running"
  | "child-dispatched"
  | "paused"
  | "blocked"
  | "cluster-complete"
  | "finalized"
  | "delivered"
  | "complete"
  | "canceled";

export type ResumeSource = "current-state" | "ledger" | "bootstrap";

export interface LedgerBlocker {
  summary: string;
  unblock_condition: string;
  [key: string]: unknown;
}

export interface LedgerValidation {
  status: string;
  [key: string]: unknown;
}

export interface LedgerBudget {
  name: string;
  value: number;
  limit: number;
  [key: string]: unknown;
}

export interface LedgerBaseEvent {
  schema_version: 1;
  event_id: string;
  event: string;
  run_id: string;
  run_type: LedgerRunType;
  cluster_id: string | null;
  issue_id: string | null;
  branch: string;
  status: LedgerStatus;
  completed_children: string[];
  open_children: string[];
  next_child: string | null;
  last_commit: string | null;
  pr_url: string | null;
  timestamp: string;
  parent_run_id?: string;
  related_run_id?: string;
  worktree?: string;
  base_branch?: string;
  base_sha?: string;
  linear_status?: string;
  blocker?: LedgerBlocker;
  validation?: LedgerValidation;
  actor?: Record<string, unknown>;
  source?: Record<string, unknown>;
}

export interface RunStartedEvent extends LedgerBaseEvent {
  event: "run-started";
  status: "running" | "ready";
}

export interface RunResumedEvent extends LedgerBaseEvent {
  event: "run-resumed";
  status: "running";
  resume_source: ResumeSource;
  resume_reason: string;
}

export interface ChildDispatchedEvent extends LedgerBaseEvent {
  event: "child-dispatched";
  issue_id: string;
  status: "child-dispatched" | "running";
  next_child: string;
  dispatch_epoch: number;
}

export interface ChildCompletedEvent extends LedgerBaseEvent {
  event: "child-completed";
  issue_id: string;
  status: "running" | "paused" | "cluster-complete";
  last_commit: string | null;
  validation: LedgerValidation;
}

export interface RunPausedEvent extends LedgerBaseEvent {
  event: "run-paused";
  status: "paused";
  pause_reason: string;
}

export interface RunBlockedEvent extends LedgerBaseEvent {
  event: "run-blocked";
  status: "blocked";
  blocker: LedgerBlocker;
}

export interface BudgetExhaustedEvent extends LedgerBaseEvent {
  event: "budget-exhausted";
  status: "paused";
  budget: LedgerBudget;
}

export interface ClusterCompleteEvent extends LedgerBaseEvent {
  event: "cluster-complete";
  status: "cluster-complete";
  open_children: [];
  next_child: null;
}

export interface FinalizedEvent extends LedgerBaseEvent {
  event: "finalized";
  status: "finalized";
  finalize_result: Record<string, unknown>;
}

export interface PrCreatedEvent extends LedgerBaseEvent {
  event: "pr-created";
  pr_url: string;
  pr_number: number | string;
}

export interface RunCompleteEvent extends LedgerBaseEvent {
  event: "run-complete";
  status: "complete";
  open_children: [];
  next_child: null;
}

export type LedgerEvent =
  | RunStartedEvent
  | RunResumedEvent
  | ChildDispatchedEvent
  | ChildCompletedEvent
  | RunPausedEvent
  | RunBlockedEvent
  | BudgetExhaustedEvent
  | ClusterCompleteEvent
  | FinalizedEvent
  | PrCreatedEvent
  | RunCompleteEvent;

const TERMINAL_OPEN_RUN_STATUSES = new Set<LedgerStatus>(["complete", "finalized", "canceled"]);

export class LedgerWriter {
  constructor(private readonly ledgerPath = DEFAULT_LEDGER_PATH) {}

  append(event: LedgerEvent): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    appendFileSync(this.ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf-8", flag: "a" });
  }

  readAll(): LedgerEvent[] {
    if (!existsSync(this.ledgerPath)) {
      return [];
    }

    const content = readFileSync(this.ledgerPath, "utf-8").trim();
    if (content.length === 0) {
      return [];
    }

    const lines = content.split("\n");
    const events: LedgerEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]) as LedgerEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: skipping malformed ledger line ${i + 1}: ${msg}\nContent: ${lines[i]}`);
      }
    }
    return events;
  }

  queryByIssue(issueId: string): LedgerEvent[] {
    return this.readAll().filter((event) => event.cluster_id === issueId);
  }

  queryOpenRuns(): LedgerEvent[] {
    const latestByRun = new Map<string, LedgerEvent>();
    for (const event of this.readAll()) {
      latestByRun.set(event.run_id, event);
    }

    return Array.from(latestByRun.values()).filter(
      (event) => !TERMINAL_OPEN_RUN_STATUSES.has(event.status),
    );
  }
}
