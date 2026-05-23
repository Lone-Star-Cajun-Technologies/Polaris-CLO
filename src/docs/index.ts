import { Command } from "commander";
import { ingestDocs, printIngestResults } from "./ingest.js";
import { seedInstructions, seedInstructionsAll } from "./seed-instructions.js";
import { validateInstructions, printReport } from "./validate-instructions.js";

export function createDocsCommand(): Command {
  const docs = new Command("docs").description("Polaris docs lifecycle commands");

  docs
    .command("ingest [path]")
    .description("Classify and place docs into the Polaris docs authority structure")
    .option("--file <path>", "Single file to ingest")
    .option("--cluster <id>", "Cluster ID for bounded batch provenance")
    .option("--files <paths...>", "Bounded batch file list")
    .option("--dry-run", "Classify and report without moving files")
    .option("--approve-authority", "Allow placement in high-authority docs areas")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .action((
      pathArg: string | undefined,
      options: {
        file?: string;
        cluster?: string;
        files?: string[];
        dryRun?: boolean;
        approveAuthority?: boolean;
        repoRoot: string;
      },
    ) => {
      const files = options.files ?? (options.file ? [options.file] : pathArg ? [pathArg] : []);
      try {
        const results = ingestDocs(files, {
          repoRoot: options.repoRoot,
          dryRun: options.dryRun,
          clusterId: options.cluster,
          approveAuthority: options.approveAuthority,
        });
        printIngestResults(results);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

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

  docs
    .command("validate-instructions")
    .description("Check all POLARIS.md files for staleness, broken links, and missing coverage")
    .option("--path <dir>", "Validate only the given directory")
    .option("--fix", "Write POLARIS.draft.md for stale or missing files")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .action((options: { path?: string; fix?: boolean; repoRoot: string }) => {
      const report = validateInstructions({
        path: options.path,
        fix: options.fix,
        repoRoot: options.repoRoot,
      });
      printReport(report);
      if (report.hasErrors) {
        process.exit(1);
      }
    });

  return docs;
}
