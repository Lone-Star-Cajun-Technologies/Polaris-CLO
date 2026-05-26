import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { ingestDocs, printIngestResults } from "./ingest.js";
import { migrateDocs, printMigrateResults } from "./migrate.js";
import { seedInstructions, seedInstructionsAll } from "./seed-instructions.js";
import { validateInstructions, printReport } from "./validate-instructions.js";
import { doctrineDraft, doctrinePromote, doctrineDeprecate } from "./doctrine.js";

export function createDocsCommand(): Command {
  const docs = new Command("docs").description("Polaris docs lifecycle commands");

  docs
    .command("ingest [path]")
    .description("Classify and place docs into the Polaris-Docs/docs/ canonical authority structure")
    .option("--file <path>", "Single file to ingest")
    .option("--batch <cluster-id>", "Cluster ID for bounded batch ingest (reads .polaris/docs-ingest/<cluster-id>.json)")
    .option("--cluster <id>", "Alias for --batch")
    .option("--files <paths...>", "Bounded batch file list")
    .option("--dry-run", "Classify and report without moving files")
    .option("--approve-authority", "Allow placement in high-authority docs areas")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .action((
      pathArg: string | undefined,
      options: {
        file?: string;
        batch?: string;
        cluster?: string;
        files?: string[];
        dryRun?: boolean;
        approveAuthority?: boolean;
        repoRoot: string;
      },
    ) => {
      const clusterId = options.batch ?? options.cluster;
      let files = options.files ?? (options.file ? [options.file] : pathArg ? [pathArg] : []);

      if (clusterId && files.length === 0) {
        const batchFile = join(options.repoRoot, ".polaris", "docs-ingest", `${clusterId}.json`);
        try {
          const batch = JSON.parse(readFileSync(batchFile, "utf-8")) as { files?: string[] };
          files = batch.files ?? [];
        } catch (err) {
          console.error(`polaris docs ingest: cannot read batch file ${batchFile}: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }

      if (files.length === 0) {
        console.error("polaris docs ingest: provide at least one file via --file, --files, --batch, or a path argument");
        process.exit(1);
      }

      try {
        const results = ingestDocs(files, {
          repoRoot: options.repoRoot,
          dryRun: options.dryRun,
          clusterId,
          approveAuthority: options.approveAuthority,
        });
        printIngestResults(results);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  docs
    .command("migrate")
    .description("Find scattered markdown files, move them to docs/raw/, and produce an ingest cluster list")
    .option("--dry-run", "Show plan without moving files")
    .option("--migration-run-id <id>", "Override the generated migration run ID")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .action((options: { dryRun?: boolean; migrationRunId?: string; repoRoot: string }) => {
      try {
        const result = migrateDocs({
          repoRoot: options.repoRoot,
          dryRun: options.dryRun,
          migrationRunId: options.migrationRunId,
        });
        printMigrateResults(result);
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

export function createDoctrineCommand(): Command {
  const doctrine = new Command("doctrine").description("Polaris doctrine lifecycle commands");

  doctrine
    .command("draft <path>")
    .description("Move a doc from docs/raw/ or docs/doctrine/raw/ to docs/doctrine/candidate/")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated doctrine run ID")
    .action((path: string, options: { repoRoot: string; runId?: string }) => {
      try {
        const result = doctrineDraft(path, { repoRoot: options.repoRoot, runId: options.runId });
        console.log(`drafted: ${result.destination}`);
        console.log(`provenance: ${result.lifecyclePath}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  doctrine
    .command("promote <path>")
    .description("Move a doc from docs/doctrine/candidate/ to docs/doctrine/active/")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated doctrine run ID")
    .action((path: string, options: { repoRoot: string; runId?: string }) => {
      try {
        const result = doctrinePromote(path, { repoRoot: options.repoRoot, runId: options.runId });
        console.log(`promoted: ${result.destination}`);
        console.log(`provenance: ${result.lifecyclePath}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  doctrine
    .command("deprecate <path>")
    .description("Move a doc from docs/doctrine/active/ to docs/doctrine/deprecated/")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated doctrine run ID")
    .action((path: string, options: { repoRoot: string; runId?: string }) => {
      try {
        const result = doctrineDeprecate(path, {
          repoRoot: options.repoRoot,
          runId: options.runId,
        });
        console.log(`deprecated: ${result.destination}`);
        console.log(`provenance: ${result.lifecyclePath}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  return doctrine;
}
