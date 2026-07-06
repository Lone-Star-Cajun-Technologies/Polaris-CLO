import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { ensureDocsScaffold, ingestDocs, printIngestResults } from "./ingest.js";
import { runReviewSession } from "./review.js";
import { migrateDocs, printMigrateResults } from "./migrate.js";
import { seedInstructions, seedInstructionsAll, seedSummary, seedSummaryAll, seedIndex, seedIndexAll, type IneligibleEntry } from "./seed-instructions.js";
import { validateInstructions, printReport } from "./validate-instructions.js";
import { doctrineDraft, doctrinePromote, doctrineDeprecate, specPromote, migrateProvenance, backfillOkfType } from "./doctrine.js";
import { auditIngestRiskSurface, formatAuditMarkdown, formatAuditSummaryTable } from "./audit.js";
import { runTriage } from "./triage.js";
import { GraphStoreAdapter } from "../graph/store/adapter.js";
import { configureGraphQuery, getGraphStats, lookupSymbol } from "../graph/query/index.js";

export interface DocsCommandOptions {
  repoRoot?: string;
}

interface SeedAllPrintable {
  written: string[];
  skippedExists: string[];
  skippedDraft: string[];
}

/**
 * Prints the shared written/skipped-exists/skipped-draft report and summary line used by
 * every `seed-*-all` command (seed-index, seed-instructions, seed-summary, reformat-okf).
 *
 * @param filename - The generated filename (e.g. "index.md") to report against each directory.
 * @param dryRun - Whether this was a dry-run pass (controls the "would write" vs "written" label).
 * @param result - The written/skippedExists/skippedDraft arrays from a seed-*-all call.
 * @param options.leadingBlankLine - Whether to prefix the summary line with a blank line (default true).
 * @param options.extraSummary - Extra summary text appended after "skipped (draft)" (e.g. root/ineligible counts).
 */
function printSeedAllResult(
  filename: string,
  dryRun: boolean | undefined,
  { written, skippedExists, skippedDraft }: SeedAllPrintable,
  options: { leadingBlankLine?: boolean; extraSummary?: string } = {},
): void {
  const { leadingBlankLine = true, extraSummary = "" } = options;
  for (const dir of written) {
    console.log(`${dryRun ? "[dry-run] would write" : "written"}: ${dir}/${filename}`);
  }
  for (const dir of skippedExists) {
    console.log(`skipped (human-edited): ${dir}/${filename}`);
  }
  for (const dir of skippedDraft) {
    console.log(`skipped (draft exists): ${dir}/${filename}`);
  }
  console.log(
    `${leadingBlankLine ? "\n" : ""}Done. ${written.length} written, ${skippedExists.length} skipped (exists), ${skippedDraft.length} skipped (draft)${extraSummary}.`,
  );
}

/**
 * Build and return the top-level "docs" Commander command group for Polaris docs lifecycle workflows.
 *
 * @param options - Optional configuration. If `options.repoRoot` is omitted, the current working directory is used as the repository root for subcommands.
 * @returns The configured `Command` implementing the `docs` command and its subcommands.
 */
export function createDocsCommand(options: DocsCommandOptions = {}): Command {
  const defaultRepoRoot = options.repoRoot ?? process.cwd();
  const docs = new Command("docs").description("Polaris docs lifecycle commands");

  docs
    .command("init")
    .description("Create the Smart Docs canonical scaffold under smartdocs/")
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
    .description("Classify and place docs into the smartdocs/ canonical authority structure")
    .option("--batch <cluster-id>", "Cluster ID for bounded batch ingest (reads .polaris/docs-ingest/<cluster-id>.json)")
    .option("--cluster <id>", "Alias for --batch")
    .option("--files <paths...>", "Bounded batch file list")
    .option("--dry-run", "Classify and report without moving files")
    .option("--approve-authority", "Allow placement in high-authority docs areas")
    .option("--file <path>", "Single file to ingest; also scopes --approve-authority to a single file path")
    .option("--from-review-queue", "scope --approve-authority to items in the review queue")
    .option("--decision-id <id>", "scope --approve-authority to a specific decision ID")
    .option("--interactive", "pause and prompt for review decisions on each review-required document")
    .option("--confidence-threshold <n>", "classification confidence threshold (0–1, default 0.75)", parseFloat)
    .option("--destination-certainty-threshold <n>", "destination certainty threshold (0–1, default 0.70)", parseFloat)
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .action(async (
      pathArg: string | undefined,
      opts: {
        file?: string;
        batch?: string;
        cluster?: string;
        files?: string[];
        dryRun?: boolean;
        approveAuthority?: boolean;
        fromReviewQueue?: boolean;
        decisionId?: string;
        interactive?: boolean;
        confidenceThreshold?: number;
        destinationCertaintyThreshold?: number;
        repoRoot: string;
      },
    ) => {
      if (opts.approveAuthority && !opts.file && !opts.fromReviewQueue && !opts.decisionId) {
        console.error(
          "error: --approve-authority requires an explicit scope: --file <path>, --from-review-queue, or --decision-id <id>"
        );
        process.exit(1);
      }

      // Alias opts to options for compatibility with existing code below
      const options = opts;
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
          interactive: opts.interactive,
          confidenceThreshold: opts.confidenceThreshold,
          destinationCertaintyThreshold: opts.destinationCertaintyThreshold,
        });
        printIngestResults(results);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  docs
    .command("review")
    .description("Interactively review pending governance decisions in the review queue")
    .option("--queue <path>", "path to _review-queue.json (default: smartdocs/raw/_review-queue.json)")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .option("--agentic", "use LLM agent to make review decisions automatically")
    .option("--triage", "review the triage queue (_triage-queue.json) instead of the review queue")
    .action(async (opts: { queue?: string; repoRoot: string; agentic?: boolean; triage?: boolean }) => {
      const repoRoot = opts.repoRoot;
      const queueFilename = opts.triage ? "_triage-queue.json" : "_review-queue.json";
      const queueDir = opts.queue
        ? resolve(opts.repoRoot, opts.queue)
            .replace(/_review-queue\.json$/, "")
            .replace(/_triage-queue\.json$/, "")
            .replace(/\/$/, "")
        : resolve(repoRoot, "smartdocs", "raw");

      let readKey: ((p: import("../governance/types.js").ReviewPacket) => Promise<string>) | undefined;
      if (opts.agentic) {
        const { agenticDecideKey } = await import("./agentic-review.js");
        readKey = agenticDecideKey;
      }

      try {
        await runReviewSession({ repoRoot, queueDir, queueFilename, readKey });
      } catch (err) {
        console.error(`polaris docs review: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  docs
    .command("triage")
    .description("Detect contradictions, duplicates, and stale code references among candidate docs")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--batch-size <n>", "Docs per LLM call", "10")
    .option("--resume", "Resume from last checkpoint (auto-detected by default)")
    .option("--dry-run", "Plan batches and print cost estimate without calling the LLM")
    .action(async (options: { repoRoot: string; batchSize: string; resume?: boolean; dryRun?: boolean }) => {
      const repoRoot = options.repoRoot;
      const dbPath = join(repoRoot, ".polaris", "graph", "graph.sqlite");
      const graphOutputPath = join(".polaris", "graph");

      let store: GraphStoreAdapter | null = null;
      try {
        store = new GraphStoreAdapter({ repoRoot, graphOutputPath, dbPath });
        store.open();
        configureGraphQuery({ graphStore: store });
      } catch {
        configureGraphQuery({ graphStore: null });
      }

      try {
        await runTriage({
          repoRoot,
          batchSize: parseInt(options.batchSize, 10) || 10,
          resume: options.resume,
          dryRun: options.dryRun,
          symbolLookup: (name) => lookupSymbol(name) !== null,
          graphStats: () => getGraphStats(),
        });
      } catch (err) {
        console.error(`polaris docs triage: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        store?.close();
      }
    });

  docs
    .command("migrate")
    .description("Find scattered markdown files, move them to smartdocs/raw/, and produce an ingest cluster list")
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
    .command("migrate-provenance")
    .description("Migrate .provenance.json sidecars into paired .md file frontmatter and delete the sidecars")
    .option("--dry-run", "Report what would be migrated without writing or deleting anything")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .action((options: { dryRun?: boolean; repoRoot: string }) => {
      try {
        const result = migrateProvenance({ repoRoot: options.repoRoot, dryRun: options.dryRun });
        if (options.dryRun) {
          const wouldStamp = result.records.filter((r) => r.status === "skipped-dry-run");
          const noMd = result.records.filter((r) => r.status === "skipped-no-md");
          console.log(`[dry-run] would stamp ${wouldStamp.length} file(s), skip ${noMd.length} orphaned sidecar(s)`);
          for (const r of wouldStamp) {
            console.log(`  stamp: ${r.mdFile}  (sidecar: ${r.sidecar})`);
          }
          for (const r of noMd) {
            console.log(`  orphan (no .md): ${r.sidecar}`);
          }
        } else {
          console.log(`migrate-provenance complete — stamped: ${result.stamped}, skipped: ${result.skipped}, errors: ${result.errors}`);
          for (const r of result.records) {
            if (r.status === "stamped") {
              console.log(`  stamped: ${r.mdFile}`);
            } else if (r.status === "error") {
              console.log(`  error: ${r.mdFile} — ${r.error}`);
            } else if (r.status === "skipped-no-md") {
              console.log(`  orphan: ${r.sidecar}`);
            }
          }
          if (result.stamped > 0) {
            console.log(`lifecycle: ${result.lifecyclePath}`);
          }
        }
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
        printSeedAllResult(
          "POLARIS.md",
          options.dryRun,
          { written, skippedExists, skippedDraft },
          { extraSummary: `, ${rootCount} skipped (root), ${skippedIneligible.length} skipped (ineligible)` },
        );
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
        printSeedAllResult(
          "SUMMARY.md",
          options.dryRun,
          { written, skippedExists, skippedDraft },
          { extraSummary: `, ${rootCount} skipped (root), ${skippedIneligible.length} skipped (ineligible)` },
        );
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
    .command("seed-index [path]")
    .description("Generate OKF-conformant index.md files for smartdocs/")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .option("--all", "Generate index.md for all smartdocs directories lacking one")
    .option("--dry-run", "Print what would be written without writing files")
    .action((pathArg: string | undefined, options: {
      repoRoot: string;
      all?: boolean;
      dryRun?: boolean;
    }) => {
      if (options.all) {
        const {
          written,
          skippedExists,
          skippedDraft,
        } = seedIndexAll(options.repoRoot, {
          dryRun: options.dryRun,
        });
        printSeedAllResult("index.md", options.dryRun, { written, skippedExists, skippedDraft });
        return;
      }

      const targetPath = pathArg || "smartdocs";
      const result = seedIndex(targetPath, options.repoRoot, { dryRun: options.dryRun });
      if (result === "written") {
        const label = options.dryRun ? "[dry-run] would write" : "written";
        console.log(`${label}: ${targetPath}/index.md`);
      } else if (result === "skipped-exists") {
        console.warn(`warning: ${targetPath}/index.md already exists (no draft marker) — skipped`);
      } else {
        console.log(`skipped (draft exists): ${targetPath}/index.md`);
      }
    });

  docs
    .command("backfill-type")
    .description(
      "Add OKF-conformant `type` frontmatter to existing smartdocs/ files that are missing it, " +
      "deriving the value from `kind` or `doc-type` when present, else defaulting to \"raw\"."
    )
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .option("--dry-run", "Print what would be written without writing files")
    .action((options: { repoRoot: string; dryRun?: boolean }) => {
      try {
        const { updated, skipped } = backfillOkfType(options.repoRoot, { dryRun: options.dryRun });
        for (const { path, type } of updated) {
          console.log(`${options.dryRun ? "[dry-run] would add" : "added"} type: ${type} — ${path}`);
        }
        console.log(`Done. ${updated.length} updated, ${skipped.length} already had type.`);
      } catch (err) {
        console.error(`polaris docs backfill-type: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  docs
    .command("reformat-okf")
    .description(
      "Migrate existing smartdocs to OKF structure in one step: runs migrate → seed-index --all → " +
      "seed-instructions --all → backfill-type. " +
      "Agent instruction files (CLAUDE.md, AGENTS.md, etc.) are never touched. " +
      "Use --dry-run to preview changes before writing."
    )
    .option("--dry-run", "Preview what would change without writing any files")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .action((options: { dryRun?: boolean; repoRoot: string }) => {
      const dryRun = options.dryRun;
      const repoRoot = options.repoRoot;
      const label = dryRun ? "[dry-run]" : "";

      // Step 1: migrate (moves scattered markdown to smartdocs/raw/)
      console.log(`${label ? label + " " : ""}Step 1/4: migrate`);
      try {
        const migrateResult = migrateDocs({ repoRoot, dryRun });
        printMigrateResults(migrateResult);
      } catch (err) {
        console.error(`reformat-okf: migrate failed — ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // Step 2: seed-index --all (ensures index.md with okf_version + type frontmatter in every smartdocs dir)
      console.log(`\n${label ? label + " " : ""}Step 2/4: seed-index --all`);
      try {
        const { written, skippedExists, skippedDraft } = seedIndexAll(repoRoot, { dryRun });
        printSeedAllResult("index.md", dryRun, { written, skippedExists, skippedDraft }, { leadingBlankLine: false });
      } catch (err) {
        console.error(`reformat-okf: seed-index failed — ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // Step 3: seed-instructions --all (ensures POLARIS.md drafts; never touches CLAUDE.md/AGENTS.md)
      console.log(`\n${label ? label + " " : ""}Step 3/4: seed-instructions --all`);
      try {
        const { written, skippedExists, skippedDraft, skippedIneligible, skippedRoot } = seedInstructionsAll(repoRoot, { dryRun });
        const rootCount = skippedRoot ? 1 : 0;
        printSeedAllResult(
          "POLARIS.md",
          dryRun,
          { written, skippedExists, skippedDraft },
          { leadingBlankLine: false, extraSummary: `, ${rootCount} skipped (root), ${skippedIneligible.length} skipped (ineligible)` },
        );
      } catch (err) {
        console.error(`reformat-okf: seed-instructions failed — ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // Step 4: backfill-type (existing docs missing `type` get it derived from kind/doc-type, or "raw")
      console.log(`\n${label ? label + " " : ""}Step 4/4: backfill-type`);
      try {
        const { updated, skipped } = backfillOkfType(repoRoot, { dryRun });
        for (const { path, type } of updated) {
          console.log(`${dryRun ? "[dry-run] would add" : "added"} type: ${type} — ${path}`);
        }
        console.log(`Done. ${updated.length} updated, ${skipped.length} already had type.`);
      } catch (err) {
        console.error(`reformat-okf: backfill-type failed — ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      console.log(`\nreformat-okf complete.${dryRun ? " (dry-run — no files written)" : ""}`);
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

/**
 * Build and return the "doctrine" Commander command group that registers doctrine lifecycle and spec-promotion subcommands.
 *
 * The returned command contains subcommands: `draft`, `promote`, `deprecate`, and `spec-promote`, each wired to their respective handlers and options.
 *
 * @returns A configured Commander `Command` representing the `doctrine` command group
 */
export function createDoctrineCommand(): Command {
  const doctrine = new Command("doctrine").description("Polaris doctrine lifecycle commands");

  doctrine
    .command("draft <path>")
    .description("Move a doc from smartdocs/raw/ or smartdocs/doctrine/raw/ to docs/doctrine/candidate/")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated doctrine run ID")
    .option("--reason <text>", "Reason for this draft")
    .action((path: string, options: { repoRoot: string; runId?: string; reason?: string }) => {
      try {
        const result = doctrineDraft(path, { repoRoot: options.repoRoot, runId: options.runId, reason: options.reason });
        console.log(`drafted: ${result.destination}`);
        console.log(`provenance: ${result.lifecyclePath}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  doctrine
    .command("promote <path>")
    .description("Move a doc from smartdocs/doctrine/candidate/ to smartdocs/doctrine/active/")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated doctrine run ID")
    .option("--reason <text>", "Reason for this promotion")
    .action((path: string, options: { repoRoot: string; runId?: string; reason?: string }) => {
      try {
        const result = doctrinePromote(path, {
          repoRoot: options.repoRoot,
          runId: options.runId,
          reason: options.reason,
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
    .description("Move a doc from smartdocs/doctrine/active/ to smartdocs/doctrine/deprecated/")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated doctrine run ID")
    .option("--reason <text>", "Reason for this deprecation")
    .action((path: string, options: { repoRoot: string; runId?: string; reason?: string }) => {
      try {
        const result = doctrineDeprecate(path, {
          repoRoot: options.repoRoot,
          runId: options.runId,
          reason: options.reason,
        });
        console.log(`deprecated: ${result.destination}`);
        console.log(`provenance: ${result.lifecyclePath}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  doctrine
    .command("spec-promote <path>")
    .description("Promote a raw spec from smartdocs/raw/ to smartdocs/specs/active/ after conflict check")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--run-id <id>", "Override the generated run ID")
    .option("--approve", "Proceed despite detected conflicts")
    .option("--reason <text>", "Reason for this promotion")
    .action((path: string, options: { repoRoot: string; runId?: string; approve?: boolean; reason?: string }) => {
      try {
        const result = specPromote(path, {
          repoRoot: options.repoRoot,
          runId: options.runId,
          approve: options.approve,
          reason: options.reason,
        });
        console.log(result.report);
        if (result.halted) {
          process.exit(1);
        }
        console.log(`promoted: ${result.destination}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  return doctrine;
}
