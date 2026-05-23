import { Command } from "commander";
import { seedInstructions, seedInstructionsAll } from "./seed-instructions.js";

export function createDocsCommand(): Command {
  const docs = new Command("docs").description("Polaris docs lifecycle commands");

  docs
    .command("seed-instructions [path]")
    .description("Generate a draft POLARIS.md for a directory using atlas signals")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--all", "Generate drafts for all directories lacking a POLARIS.md")
    .option("--dry-run", "Print what would be written without writing files")
    .action((pathArg: string | undefined, options: { repoRoot: string; all?: boolean; dryRun?: boolean }) => {
      if (options.all) {
        const { written, skippedExists, skippedDraft } = seedInstructionsAll(options.repoRoot, { dryRun: options.dryRun });
        for (const dir of written) {
          console.log(`${options.dryRun ? "[dry-run] would write" : "written"}: ${dir}/POLARIS.md`);
        }
        for (const dir of skippedExists) {
          console.log(`skipped (human-edited): ${dir}/POLARIS.md`);
        }
        for (const dir of skippedDraft) {
          console.log(`skipped (draft exists): ${dir}/POLARIS.md`);
        }
        console.log(`\nDone. ${written.length} written, ${skippedExists.length} skipped (exists), ${skippedDraft.length} skipped (draft).`);
        return;
      }

      if (!pathArg) {
        console.error("Error: provide a <path> argument or use --all");
        process.exit(1);
      }

      const result = seedInstructions(pathArg, options.repoRoot, { dryRun: options.dryRun });
      if (result === "written") {
        const label = options.dryRun ? "[dry-run] would write" : "written";
        console.log(`${label}: ${pathArg}/POLARIS.md`);
      } else if (result === "skipped-exists") {
        console.warn(`warning: ${pathArg}/POLARIS.md already exists (no draft marker) — skipped`);
      } else {
        console.log(`skipped (draft exists): ${pathArg}/POLARIS.md`);
      }
    });

  return docs;
}
