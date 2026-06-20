import { readState, writeStateAtomic } from "./checkpoint.js";

export interface SimplicityCommandOptions {
  bypass: boolean;
  restore: boolean;
  stateFile: string;
}

/**
 * Handles `polaris simplicity [--bypass | --restore]`.
 *
 * --bypass: sets simplicity_bypass: true for the active run (omits discipline ladder from worker prompts).
 * --restore: clears simplicity_bypass (re-enables the ladder).
 * bare: prints current bypass status without mutating state.
 */
export function runSimplicityCommand(opts: SimplicityCommandOptions): void {
  if (!opts.bypass && !opts.restore) {
    const state = readState(opts.stateFile);
    if (state.simplicity_bypass) {
      console.log("Simplicity bypass: on — discipline ladder omitted for this run.");
    } else {
      console.log("Simplicity bypass: off — discipline mode comes from project config/default.");
    }
    return;
  }

  const state = readState(opts.stateFile);

  if (opts.bypass) {
    state.simplicity_bypass = true;
    writeStateAtomic(opts.stateFile, state);
    console.log("Simplicity bypass enabled — discipline ladder will be omitted from worker prompts for this run.");
    return;
  }

  // restore
  state.simplicity_bypass = false;
  writeStateAtomic(opts.stateFile, state);
  console.log("Simplicity bypass cleared — discipline ladder will be injected into worker prompts.");
}
