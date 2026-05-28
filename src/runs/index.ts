import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { DEFAULT_LEDGER_PATH, type LedgerEvent } from "../loop/ledger.js";
import { runRunsList } from "./list.js";
import { runRunsShow } from "./show.js";
import { runRunsLedgerTail } from "./ledger-tail.js";
import { runRunsReconcile } from "./reconcile.js";

export interface RunsCommandOptions {
  repoRoot: string;
}

export interface RunsReadResult {
  ledgerPath: string;
  rawLines: string[];
  events: LedgerEvent[];
}

export function resolveLedgerPath(repoRoot: string): string {
  return resolve(repoRoot, DEFAULT_LEDGER_PATH);
}

export function resolveStateFile(repoRoot: string): string {
  const taskchainPath = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  const polarisPath = join(repoRoot, ".polaris", "runs", "current-state.json");
  if (existsSync(taskchainPath)) return taskchainPath;
  if (existsSync(polarisPath)) return polarisPath;
  return taskchainPath;
}

export function readLedger(repoRoot: string): RunsReadResult | null {
  const ledgerPath = resolveLedgerPath(repoRoot);
  if (!existsSync(ledgerPath)) {
    return null;
  }

  const raw = readFileSync(ledgerPath, "utf-8");
  const rawLines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const events: LedgerEvent[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    try {
      events.push(JSON.parse(rawLines[i]) as LedgerEvent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: skipping malformed ledger line ${i + 1} in ${ledgerPath}: ${msg}\nContent: ${rawLines[i]}`);
    }
  }
  return {
    ledgerPath,
    rawLines,
    events,
  };
}

function noLedgerFound(): void {
  process.stdout.write("no ledger found\n");
}

export function createRunsCommand(options: RunsCommandOptions): Command {
  const runs = new Command("runs")
    .description("safe/read-only: inspect Polaris global run ledger")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .action(() => {
      runs.outputHelp();
    });

  runs
    .command("list")
    .description("safe/read-only: list runs from the global ledger")
    .option("--open", "Only show runs whose latest status is not complete or finalized")
    .action((commandOptions: { open?: boolean }) => {
      const ledger = readLedger(options.repoRoot);
      if (!ledger) {
        noLedgerFound();
        return;
      }
      runRunsList(ledger.events, { open: Boolean(commandOptions.open) });
    });

  runs
    .command("show")
    .description("safe/read-only: show all ledger events for a run")
    .argument("<run-id>", "Run ID to inspect")
    .action((runId: string) => {
      const ledger = readLedger(options.repoRoot);
      if (!ledger) {
        noLedgerFound();
        return;
      }
      runRunsShow(ledger.events, runId);
    });

  const ledger = runs
    .command("ledger")
    .description("safe/read-only: inspect raw ledger storage")
    .showHelpAfterError()
    .action(() => {
      ledger.outputHelp();
    });

  ledger
    .command("tail")
    .description("safe/read-only: print the last N raw ledger lines")
    .option("--n <count>", "Number of lines to print", "20")
    .action((commandOptions: { n: string }) => {
      const ledgerData = readLedger(options.repoRoot);
      if (!ledgerData) {
        noLedgerFound();
        return;
      }
      runRunsLedgerTail(ledgerData.rawLines, commandOptions.n);
    });

  runs
    .command("reconcile")
    .description("safe/read-only: report divergence between ledger and current-state.json")
    .action(() => {
      const ledgerData = readLedger(options.repoRoot);
      if (!ledgerData) {
        noLedgerFound();
        return;
      }
      runRunsReconcile(ledgerData.events, {
        repoRoot: options.repoRoot,
        stateFile: resolveStateFile(options.repoRoot),
      });
    });

  return runs;
}
