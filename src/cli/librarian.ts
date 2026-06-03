import { Command } from "commander";
import { resolve } from "node:path";
import { generateLibrarianPacket } from "../cognition/librarian-packet.js";

export function createLibrarianCommand(options: { repoRoot?: string } = {}): Command {
  const repoRootDefault = options.repoRoot ?? resolve(process.cwd());

  const librarian = new Command("librarian")
    .description("Closeout Librarian tools")
    .showHelpAfterError()
    .showSuggestionAfterError();

  librarian
    .command("packet <cluster-id>")
    .description("generate Closeout Librarian packet for a completed cluster")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Path to current-state.json (canonical path preferred)")
    .action(
      (
        clusterId: string,
        cmdOptions: { repoRoot: string; stateFile?: string },
      ) => {
        try {
          generateLibrarianPacket({
            repoRoot: cmdOptions.repoRoot,
            clusterId,
            stateFile: cmdOptions.stateFile,
          });
        } catch (err) {
          process.stderr.write(
            `librarian packet error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      },
    );

  return librarian;
}
