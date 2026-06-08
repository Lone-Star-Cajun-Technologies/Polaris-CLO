import type { Command } from "commander";
import { loadConfig } from "./loader.js";
import { runDoctor, printDoctorReport } from "./doctor.js";

export interface ConfigShowOptions {
  repoRoot: string;
}

export interface ConfigDoctorOptions {
  repoRoot: string;
}

export type RunConfigShow = (options: ConfigShowOptions) => void;
export type RunConfigDoctor = (options: ConfigDoctorOptions) => void;

export function getResolvedConfigJson(repoRoot: string): string {
  return `${JSON.stringify(loadConfig(repoRoot), null, 2)}\n`;
}

export const runConfigShow: RunConfigShow = ({ repoRoot }) => {
  process.stdout.write(getResolvedConfigJson(repoRoot));
};

export const runConfigDoctor: RunConfigDoctor = ({ repoRoot }) => {
  const report = runDoctor(repoRoot);
  printDoctorReport(report);
};

export function createConfigCommand(options: {
  repoRoot: string;
  runConfigShow?: RunConfigShow;
  runConfigDoctor?: RunConfigDoctor;
}): Command {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Command } = require("commander") as typeof import("commander");
  const showHandler = options.runConfigShow ?? runConfigShow;
  const doctorHandler = options.runConfigDoctor ?? runConfigDoctor;
  const command = new Command("config")
    .description("safe/read-only: inspect resolved Polaris configuration")
    .showHelpAfterError()
    .action(() => {
      command.outputHelp();
    });

  command
    .command("show")
    .description("safe/read-only: print resolved config as formatted JSON")
    .action(() => {
      showHandler({ repoRoot: options.repoRoot });
    });

  command
    .command("doctor")
    .description("safe/read-only: check configuration readiness and report issues")
    .action(() => {
      doctorHandler({ repoRoot: options.repoRoot });
    });

  return command;
}
