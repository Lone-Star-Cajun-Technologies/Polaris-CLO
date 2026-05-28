import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { ensureDocsScaffold, ingestDocs, printIngestResults } from "./ingest.js";
import { migrateDocs, printMigrateResults } from "./migrate.js";
import { seedInstructions, seedInstructionsAll, seedSummary, seedSummaryAll, type IneligibleEntry } from "./seed-instructions.js";
import { validateInstructions, printReport } from "./validate-instructions.js";
import { doctrineDraft, doctrinePromote, doctrineDeprecate } from "./doctrine.js";
import { auditIngestRiskSurface, formatAuditMarkdown, formatAuditSummaryTable } from "./audit.js";

export interface DocsCommandOptions {
  repoRoot?: string;
}

export function createDocsCommand(options: DocsCommandOptions = {}): Command {
  const defaultRepoRoot = options.repoRoot ?? process.cwd();
  const docs = new Command("docs").description("Polaris docs lifecycle commands");

  docs
    .command("init")
    .description("Create the Smart Docs canonical scaffold under smartdocs/docs/")
    .option("--dry-run", "Print what would be created without writing directories")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .action((options: { dryRun?: boolean; repoRoot: string }) => {
      try {
        const result = ensureDocsScaffold(options.repoRoot, { dryRun: options.dryRun });
        const createLabel = options.dryRun ? "[dry-run] would create" : "created";

        for (const dir of result.created) {
          console.log(`${createLabel}: ${dir}`);
        }
        for (const dir of result.existing) {
          console.log(`already exists: ${dir}`);
        }
        console.log(`\nDone. ${result.created.length} ${options.dryRun ? "would be created" : "created"}, ${result.existing.length} already exists.`);
      } catch (err) {
        console.error(`polaris docs init: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  docs
    .command("ingest [path]")
    .description("Classify and place docs into the smartdocs/docs/ canonical authority structure")
    .option("--file <path>", "Single file to ingest")
    .option("--batch <cluster-id>", "Cluster ID for bounded batch ingest (reads .polaris/docs-ingest/<cluster-id>.json)")
    .option("--cluster <id>", "Alias for --batch")
    .option("--files <paths...>", "Bounded batch file list")
    .option("--dry-run", "Classify and report without moving files")
    .option("--approve-authority", "Allow placement in high-authority docs areas")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
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

      // Validate clusterId
      if (clusterId && !/^[A-Za-z0-9_-]+$/.test(clusterId)) {
        console.error(`polaris docs ingest: invalid cluster ID "${clusterId}" - must contain only alphanumeric, underscore, or hyphen characters`);
        process.exit(1);
      }

      let files = options.files ?? (options.file ? [options.file] : pathArg ? [pathArg] : []);

      if (clusterId && files.length === 0) {
        const batchFile = join(options.repoRoot, ".polaris", "docs-ingest", `${clusterId}.json`);
        try {
          const rawContent = readFileSync(batchFile, "utf-8");
          const batch = JSON.parse(rawContent);

          // Validate parsed batch structure
          if (typeof batch !== "object" || batch === null || Array.isArray(batch)) {
            console.error(`polaris docs ingest: batch file ${batchFile} must contain a JSON object`);
            process.exit(1);
          }

          if (!("files" in batch) || !Array.isArray(batch.files)) {
            console.error(`polaris docs ingest: batch file ${batchFile} must contain a "files" array`);
            process.exit(1);
          }

          // Validate each file path
          for (const file of batch.files) {
            if (typeof file !== "string") {
              console.error(`polaris docs ingest: batch file ${batchFile} contains non-string file entry`);
              process.exit(1);
            }
            if (file.includes("..") || file.includes("\\") || file.startsWith("/")) {
              console.error(`polaris docs ingest: batch file ${batchFile} contains invalid file path "${file}" (contains "..", path separators, or is absolute)`);
              process.exit(1);
            }
          }

          // Validate resolved paths are within ingest directory
          const ingestDir = resolve(options.repoRoot, ".polaris/docs-ingest");
          for (const file of batch.files) {
            const resolvedPath = resolve(ingestDir, file);
            if (!resolvedPath.startsWith(ingestDir)) {
              console.error(`polaris docs ingest: file path "${file}" resolves outside ingest directory`);
              process.exit(1);
            }
          }

          files = batch.files;
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
    .description("Find scattered markdown files, move them to smartdocs/docs/raw/, and produce an ingest cluster list")
    .option("--dry-run", "Show plan without moving files")
    .option("--migration-run-id <id>", "Override the generated migration run ID")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
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
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .option("--all", "Generate drafts for all directories lacking a POLARIS.md")
    .option("--dry-run", "Print what would be written without writing files")
    .option("--include-agent-folders", "Include .codex, .claude, .agents folders (default: skip)")
    .option("--include-hidden", "Include all hidden directories starting with . (default: skip)")
    .option("--include-root", "Include root directory (default: skip for POLARIS.md)")
    .action((pathArg: string | undefined, options: {
      repoRoot: string;
      all?: boolean;
      dryRun?: boolean;
      includeAgentFolders?: boolean;
      includeHidden?: boolean;
      includeRoot?: boolean;
    }) => {
      if (options.all) {
        const {
          written,
          skippedExists,
          skippedDraft,
          skippedIneligible,
          skippedRoot,
        } = seedInstructionsAll(options.repoRoot, {
          dryRun: options.dryRun,
          includeAgentFolders: options.includeAgentFolders,
          includeHidden: options.includeHidden,
          includeRoot: options.includeRoot,
        });
        for (const dir of written) {
          console.log(`${options.dryRun ? "[dry-run] would write" : "written"}: ${dir}/POLARIS.md`);
        }
        for (const dir of skippedExists) {
          console.log(`skipped (human-edited): ${dir}/POLARIS.md`);
        }
        for (const dir of skippedDraft) {
          console.log(`skipped (draft exists): ${dir}/POLARIS.md`);
        }
        if (options.dryRun) {
          if (skippedRoot) {
            console.log(`\nSkipped (root):`);
            console.log(`  ${skippedRoot.path}/ (${skippedRoot.reason})`);
          }
          if (skippedIneligible.length > 0) {
            // Group by category
            const byCategory: Record<string, IneligibleEntry[]> = {};
            for (const entry of skippedIneligible) {
              const cat = entry.category || "other";
              if (!byCategory[cat]) byCategory[cat] = [];
              byCategory[cat].push(entry);
            }
            for (const [category, entries] of Object.entries(byCategory)) {
              console.log(`\nSkipped (${category}):`);
              for (const entry of entries) {
                console.log(`  ${entry.path}/ (${entry.reason})`);
              }
            }
          }
        }
        const rootCount = skippedRoot ? 1 : 0;
        console.log(`\nDone. ${written.length} written, ${skippedExists.length} skipped (exists), ${skippedDraft.length} skipped (draft), ${rootCount} skipped (root), ${skippedIneligible.length} skipped (ineligible).`);
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
    .command("seed-summary [path]")
    .description("Generate a draft SUMMARY.md for a directory using atlas signals")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .option("--all", "Generate drafts for all directories lacking a SUMMARY.md")
    .option("--dry-run", "Print what would be written without writing files")
    .option("--include-agent-folders", "Include .codex, .claude, .agents folders (default: skip)")
    .option("--include-hidden", "Include all hidden directories starting with . (default: skip)")
    .option("--include-root", "Include root directory (default: skip)")
    .action((pathArg: string | undefined, options: {
      repoRoot: string;
      all?: boolean;
      dryRun?: boolean;
      includeAgentFolders?: boolean;
      includeHidden?: boolean;
      includeRoot?: boolean;
    }) => {
      if (options.all) {
        const {
          written,
          skippedExists,
          skippedDraft,
          skippedIneligible,
          skippedRoot,
        } = seedSummaryAll(options.repoRoot, {
          dryRun: options.dryRun,
          includeAgentFolders: options.includeAgentFolders,
          includeHidden: options.includeHidden,
          includeRoot: options.includeRoot,
        });
        for (const dir of written) {
          console.log(`${options.dryRun ? "[dry-run] would write" : "written"}: ${dir}/SUMMARY.md`);
        }
        for (const dir of skippedExists) {
          console.log(`skipped (human-edited): ${dir}/SUMMARY.md`);
        }
        for (const dir of skippedDraft) {
          console.log(`skipped (draft exists): ${dir}/SUMMARY.md`);
        }
        if (options.dryRun) {
          if (skippedRoot) {
            console.log(`\nSkipped (root):`);
            console.log(`  ${skippedRoot.path}/ (${skippedRoot.reason})`);
          }
          if (skippedIneligible.length > 0) {
            // Group by category
            const byCategory: Record<string, IneligibleEntry[]> = {};
            for (const entry of skippedIneligible) {
              const cat = entry.category || "other";
              if (!byCategory[cat]) byCategory[cat] = [];
              byCategory[cat].push(entry);
            }
            for (const [category, entries] of Object.entries(byCategory)) {
              console.log(`\nSkipped (${category}):`);
              for (const entry of entries) {
                console.log(`  ${entry.path}/ (${entry.reason})`);
              }
            }
          }
        }
        const rootCount = skippedRoot ? 1 : 0;
        console.log(`\nDone. ${written.length} written, ${skippedExists.length} skipped (exists), ${skippedDraft.length} skipped (draft), ${rootCount} skipped (root), ${skippedIneligible.length} skipped (ineligible).`);
        return;
      }

      if (!pathArg) {
        console.error("Error: provide a <path> argument or use --all");
        process.exit(1);
      }

      const result = seedSummary(pathArg, options.repoRoot, { dryRun: options.dryRun });
      if (result === "written") {
        const label = options.dryRun ? "[dry-run] would write" : "written";
        console.log(`${label}: ${pathArg}/SUMMARY.md`);
      } else if (result === "skipped-exists") {
        console.warn(`warning: ${pathArg}/SUMMARY.md already exists (no draft marker) — skipped`);
      } else {
        console.log(`skipped (draft exists): ${pathArg}/SUMMARY.md`);
      }
    });

  docs
    .command("audit")
    .description("Scan repo for files at risk of recursive ingestion")
    .option("--json", "Emit AuditResult as JSON")
    .option("--output <path>", "Write markdown findings report to file")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .action((options: { json?: boolean; output?: string; repoRoot: string }) => {
      if (options.json && options.output) {
        console.error("Error: --json and --output are mutually exclusive; provide only one");
        process.exit(1);
      }
      try {
        const result = auditIngestRiskSurface(options.repoRoot);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (options.output) {
          writeFileSync(options.output, formatAuditMarkdown(result), "utf-8");
          console.log(`written: ${options.output}`);
        } else {
          console.log(formatAuditSummaryTable(result));
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  docs
    .command("validate-instructions")
    .description("Check all POLARIS.md files for staleness, broken links, and missing coverage")
    .option("--path <dir>", "Validate only the given directory")
    .option("--fix", "Write POLARIS.draft.md for stale or missing files")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
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
    .description("Move a doc from smartdocs/docs/raw/ or smartdocs/docs/doctrine/raw/ to docs/doctrine/candidate/")
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
    .description("Move a doc from smartdocs/docs/doctrine/candidate/ to smartdocs/docs/doctrine/active/")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated doctrine run ID")
    .action((path: string, options: { repoRoot: string; runId?: string }) => {
      try {
        const result = doctrinePromote(path, {
          repoRoot: options.repoRoot,
          runId: options.runId
        });
        console.log(`promoted: ${result.destination}`);
        console.log(`provenance: ${result.lifecyclePath}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  doctrine
    .command("deprecate <path>")
    .description("Move a doc from smartdocs/docs/doctrine/active/ to smartdocs/docs/doctrine/deprecated/")
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
