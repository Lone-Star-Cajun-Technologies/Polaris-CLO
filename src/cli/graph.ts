import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config/loader.js";
import { getDefaultAdapterRegistry } from "../graph/adapter/registry.js";
import type { GraphCapabilityReport } from "../graph/capability/index.js";
import { runExtractionPipeline } from "../graph/parser/pipeline.js";
import { configureGraphQuery, getCallees, getCallers, getImpactedFiles, lookupSymbol } from "../graph/query/index.js";
import type { GraphFile, GraphSymbol } from "../graph/query/types.js";
import { runGraphResolver } from "../graph/resolver/index.js";
import { GraphStoreAdapter } from "../graph/store/adapter.js";

export interface GraphCommandOptions {
  repoRoot: string;
}

export function createGraphCommand(options: GraphCommandOptions): Command {
  const graphCommand = new Command("graph")
    .description("Build and inspect the repository function graph")
    .showHelpAfterError()
    .showSuggestionAfterError();

  graphCommand.action(() => failMissingSubcommand(graphCommand, "polaris graph"));

  graphCommand
    .command("build")
    .description("Build graph artifacts from configured source roots")
    .option("-r, --repo-root <path>", "Repository root", options.repoRoot)
    .option("--dry-run", "Print the build plan and skip writes")
    .option("--json", "Emit JSON output")
    .action(async (commandOptions: { repoRoot: string; dryRun?: boolean; json?: boolean }) => {
      const repoRoot = resolve(commandOptions.repoRoot ?? options.repoRoot);
      const dryRun = commandOptions.dryRun ?? false;
      const json = commandOptions.json ?? false;
      const plan = createBuildPlan(repoRoot);

      if (dryRun) {
        const output = {
          mode: "dry-run",
          ...plan,
        };
        if (json) {
          console.log(JSON.stringify(output, null, 2));
        } else {
          printBuildPlan(output);
        }
        return;
      }

      const store = new GraphStoreAdapter({
        repoRoot,
        graphOutputPath: plan.outputPathRelative,
        dbPath: plan.dbPathRelative,
      });

      try {
        store.open();
        const extraction = await runExtractionPipeline(plan.sourceFiles, {
          graphStore: store,
          logger: { warn: (message) => process.stderr.write(`${message}\n`) },
        });
        const resolver = runGraphResolver({ graphStore: store });

        const output = {
          mode: "build",
          outputPath: plan.outputPathAbsolute,
          dbPath: plan.dbPathAbsolute,
          sourceRoots: plan.sourceRootsAbsolute,
          sourceFileCount: plan.sourceFiles.length,
          extraction,
          resolver,
        };
        if (json) {
          console.log(JSON.stringify(output, null, 2));
        } else {
          printBuildSummary(output);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`graph build failed: ${message}\n`);
        process.exit(1);
      } finally {
        store.close();
      }
    });

  graphCommand
    .command("query <symbol>")
    .description("Lookup a symbol and print callers/callees")
    .option("-r, --repo-root <path>", "Repository root", options.repoRoot)
    .option("--file <path>", "Optional file path filter for symbol lookup")
    .option("--json", "Emit JSON output")
    .option("--dry-run", "Print the query plan and skip execution")
    .action((symbol: string, commandOptions: { repoRoot: string; file?: string; json?: boolean; dryRun?: boolean }) => {
      const repoRoot = resolve(commandOptions.repoRoot ?? options.repoRoot);
      const plan = createBuildPlan(repoRoot);
      const fileFilter = commandOptions.file ? resolve(repoRoot, commandOptions.file) : undefined;
      const json = commandOptions.json ?? false;
      const dryRun = commandOptions.dryRun ?? false;

      if (dryRun) {
        const output = {
          mode: "dry-run",
          command: "query",
          symbol,
          file: fileFilter ?? null,
          outputPath: plan.outputPathAbsolute,
          dbPath: plan.dbPathAbsolute,
        };
        if (json) {
          console.log(JSON.stringify(output, null, 2));
        } else {
          printDryRunPlan(output);
        }
        return;
      }

      const store = new GraphStoreAdapter({
        repoRoot,
        graphOutputPath: plan.outputPathRelative,
        dbPath: plan.dbPathRelative,
      });

      try {
        store.open();
        configureGraphQuery({ graphStore: store });
        const target = lookupSymbol(symbol, fileFilter);
        if (!target) {
          process.stderr.write(`symbol not found: ${symbol}\n`);
          process.exit(1);
        }

        const output = {
          symbol: target,
          callers: getCallers(target.id),
          callees: getCallees(target.id),
          outputPath: plan.outputPathAbsolute,
          dbPath: plan.dbPathAbsolute,
        };

        if (json) {
          console.log(JSON.stringify(output, null, 2));
        } else {
          printQueryTable(output.symbol, output.callers, output.callees);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`graph query failed: ${message}\n`);
        process.exit(1);
      } finally {
        configureGraphQuery({ graphStore: null });
        store.close();
      }
    });

  graphCommand
    .command("impact <symbol>")
    .description("Compute transitively impacted files for a symbol")
    .option("-r, --repo-root <path>", "Repository root", options.repoRoot)
    .option("--file <path>", "Optional file path filter for symbol lookup")
    .option("--json", "Emit JSON output")
    .option("--dry-run", "Print the impact plan and skip execution")
    .action((symbol: string, commandOptions: { repoRoot: string; file?: string; json?: boolean; dryRun?: boolean }) => {
      const repoRoot = resolve(commandOptions.repoRoot ?? options.repoRoot);
      const plan = createBuildPlan(repoRoot);
      const fileFilter = commandOptions.file ? resolve(repoRoot, commandOptions.file) : undefined;
      const json = commandOptions.json ?? false;
      const dryRun = commandOptions.dryRun ?? false;

      if (dryRun) {
        const output = {
          mode: "dry-run",
          command: "impact",
          symbol,
          file: fileFilter ?? null,
          outputPath: plan.outputPathAbsolute,
          dbPath: plan.dbPathAbsolute,
        };
        if (json) {
          console.log(JSON.stringify(output, null, 2));
        } else {
          printDryRunPlan(output);
        }
        return;
      }

      const store = new GraphStoreAdapter({
        repoRoot,
        graphOutputPath: plan.outputPathRelative,
        dbPath: plan.dbPathRelative,
      });

      try {
        store.open();
        configureGraphQuery({ graphStore: store });
        const target = lookupSymbol(symbol, fileFilter);
        if (!target) {
          process.stderr.write(`symbol not found: ${symbol}\n`);
          process.exit(1);
        }

        const files = getImpactedFiles(target.id);
        const output = {
          symbol: target,
          impactedFiles: files,
          outputPath: plan.outputPathAbsolute,
          dbPath: plan.dbPathAbsolute,
        };

        if (json) {
          console.log(JSON.stringify(output, null, 2));
        } else {
          printImpactTable(output.symbol, output.impactedFiles);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`graph impact failed: ${message}\n`);
        process.exit(1);
      } finally {
        configureGraphQuery({ graphStore: null });
        store.close();
      }
    });

  return graphCommand;
}

interface GraphBuildPlan {
  outputPathRelative: string;
  outputPathAbsolute: string;
  dbPathRelative: string;
  dbPathAbsolute: string;
  sourceRootsAbsolute: string[];
  sourceFiles: string[];
}

function createBuildPlan(repoRoot: string): GraphBuildPlan {
  const config = loadConfig(repoRoot);
  const outputPathRelative = config.graph.outputPath ?? ".polaris/graph";
  const outputPathAbsolute = resolve(repoRoot, outputPathRelative);
  const dbPathRelative = join(outputPathRelative, "graph.sqlite");
  const dbPathAbsolute = resolve(repoRoot, dbPathRelative);
  const sourceRoots = (config.repo.sourceRoots ?? ["src"])
    .filter((root): root is string => typeof root === "string" && root.length > 0)
    .map((root) => resolve(repoRoot, root));
  const sourceFiles = collectSourceFiles(sourceRoots);

  return {
    outputPathRelative,
    outputPathAbsolute,
    dbPathRelative,
    dbPathAbsolute,
    sourceRootsAbsolute: sourceRoots,
    sourceFiles,
  };
}

function collectSourceFiles(sourceRoots: readonly string[]): string[] {
  const files: string[] = [];
  const supportedExtensions = new Set(getDefaultAdapterRegistry().getSupportedExtensions());

  for (const root of sourceRoots) {
    if (!existsSync(root)) {
      continue;
    }
    for (const filePath of walkDirectory(root)) {
      if (supportedExtensions.has(extname(filePath).toLowerCase())) {
        files.push(filePath);
      }
    }
  }

  return Array.from(new Set(files)).sort((left, right) => left.localeCompare(right));
}

function* walkDirectory(root: string, visited: Set<string> = new Set()): Generator<string> {
  const realRoot = realpathSync(root);
  if (visited.has(realRoot)) return;
  visited.add(realRoot);
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(fullPath, visited);
      continue;
    }
    yield fullPath;
  }
}

function failMissingSubcommand(command: Command, commandName: string): never {
  const unknownSubcommand = command.args[0];
  const message = unknownSubcommand
    ? `error: unknown command '${unknownSubcommand}' for '${commandName}'. Run '${commandName} --help'.`
    : `error: missing command for '${commandName}'. Run '${commandName} --help'.`;
  command.error(message, {
    code: "commander.missingCommand",
    exitCode: 1,
  });
}

function printBuildPlan(plan: {
  mode: string;
  outputPathRelative: string;
  outputPathAbsolute: string;
  dbPathRelative: string;
  dbPathAbsolute: string;
  sourceRootsAbsolute: string[];
  sourceFiles: string[];
}): void {
  console.log("graph build plan (dry-run)");
  console.log(`output path: ${plan.outputPathAbsolute}`);
  console.log(`db path: ${plan.dbPathAbsolute}`);
  console.log(`source roots: ${plan.sourceRootsAbsolute.length}`);
  for (const root of plan.sourceRootsAbsolute) {
    console.log(`  - ${root}`);
  }
  console.log(`source files: ${plan.sourceFiles.length}`);
}

function printBuildSummary(output: {
  mode: string;
  outputPath: string;
  dbPath: string;
  sourceRoots: string[];
  sourceFileCount: number;
  extraction: Awaited<ReturnType<typeof runExtractionPipeline>>;
  resolver: ReturnType<typeof runGraphResolver>;
}): void {
  console.log("graph build complete");
  console.log(`output path: ${output.outputPath}`);
  console.log(`db path: ${output.dbPath}`);
  console.log(`source roots: ${output.sourceRoots.length}`);
  console.log(`source files: ${output.sourceFileCount}`);
  console.log(
    `extraction: processed=${output.extraction.processedFiles} succeeded=${output.extraction.succeededFiles} failed=${output.extraction.failedFiles}`,
  );
  console.log(
    `resolver: imports=${output.resolver.importsEdges} calls=${output.resolver.callsEdges} defined-in=${output.resolver.definedInEdges} unresolved-imports=${output.resolver.unresolvedImports} unresolved-calls=${output.resolver.unresolvedCalls}`,
  );
  printCapabilityReport(output.extraction.capability);
}

function printCapabilityReport(report: GraphCapabilityReport): void {
  const rows = Object.entries(report.coverage).sort(([left], [right]) => left.localeCompare(right));
  const languageWidth = Math.max("Language".length, ...rows.map(([language]) => language.length));
  const filesWidth = Math.max(
    "Files".length,
    ...rows.map(([, entry]) => String(entry.filesDiscovered).length),
    String(rows.reduce((total, [, entry]) => total + entry.filesDiscovered, 0)).length,
  );
  const symbolWidth = Math.max(
    "Symbol-Level".length,
    ...rows.map(([, entry]) => String(entry.filesSymbolLevel).length),
    String(rows.reduce((total, [, entry]) => total + entry.filesSymbolLevel, 0)).length,
  );
  const fileWidth = Math.max(
    "File-Level".length,
    ...rows.map(([, entry]) => String(entry.filesFileLevel).length),
    String(rows.reduce((total, [, entry]) => total + entry.filesFileLevel, 0)).length,
  );
  const failedWidth = Math.max(
    "Failed".length,
    ...rows.map(([, entry]) => String(entry.filesFailed).length),
    String(rows.reduce((total, [, entry]) => total + entry.filesFailed, 0)).length,
  );

  const totalFiles = rows.reduce((total, [, entry]) => total + entry.filesDiscovered, 0);
  const totalSymbolLevel = rows.reduce((total, [, entry]) => total + entry.filesSymbolLevel, 0);
  const totalFileLevel = rows.reduce((total, [, entry]) => total + entry.filesFileLevel, 0);
  const totalFailed = rows.reduce((total, [, entry]) => total + entry.filesFailed, 0);

  console.log("");
  console.log("Graph Build - Coverage Report");
  console.log("-".repeat(languageWidth + filesWidth + symbolWidth + fileWidth + failedWidth + 16));
  console.log(
    `${"Language".padEnd(languageWidth)}  ${"Files".padStart(filesWidth)}  ${"Symbol-Level".padStart(symbolWidth)}  ${"File-Level".padStart(fileWidth)}  ${"Failed".padStart(failedWidth)}`,
  );

  for (const [language, entry] of rows) {
    console.log(
      `${language.padEnd(languageWidth)}  ${String(entry.filesDiscovered).padStart(filesWidth)}  ${String(entry.filesSymbolLevel).padStart(symbolWidth)}  ${String(entry.filesFileLevel).padStart(fileWidth)}  ${String(entry.filesFailed).padStart(failedWidth)}`,
    );
  }

  console.log("-".repeat(languageWidth + filesWidth + symbolWidth + fileWidth + failedWidth + 16));
  console.log(
    `${"Total".padEnd(languageWidth)}  ${String(totalFiles).padStart(filesWidth)}  ${String(totalSymbolLevel).padStart(symbolWidth)}  ${String(totalFileLevel).padStart(fileWidth)}  ${String(totalFailed).padStart(failedWidth)}`,
  );
  console.log(`Symbol-level coverage: ${report.symbolLevelPercent.toFixed(1)}%`);
  console.log(`Total file coverage: ${report.totalCoveragePercent.toFixed(1)}%`);
}

function printDryRunPlan(plan: {
  mode: string;
  command: string;
  symbol: string;
  file: string | null;
  outputPath: string;
  dbPath: string;
}): void {
  console.log(`graph ${plan.command} plan (dry-run)`);
  console.log(`symbol: ${plan.symbol}`);
  if (plan.file) {
    console.log(`file filter: ${plan.file}`);
  }
  console.log(`output path: ${plan.outputPath}`);
  console.log(`db path: ${plan.dbPath}`);
}

function printQueryTable(symbol: GraphSymbol, callers: GraphSymbol[], callees: GraphSymbol[]): void {
  console.log(`symbol: ${symbol.name} (${symbol.kind})`);
  console.log(`id: ${symbol.id}`);
  console.log(`file: ${symbol.filePath}`);
  if (symbol.signature) {
    console.log(`signature: ${symbol.signature}`);
  }
  console.log("");
  printSymbolRows("callers", callers);
  console.log("");
  printSymbolRows("callees", callees);
}

function printImpactTable(symbol: GraphSymbol, impactedFiles: GraphFile[]): void {
  console.log(`symbol: ${symbol.name} (${symbol.kind})`);
  console.log(`id: ${symbol.id}`);
  console.log(`file: ${symbol.filePath}`);
  console.log("");
  console.log(`impacted files (${impactedFiles.length})`);
  if (impactedFiles.length === 0) {
    console.log("  none");
    return;
  }
  for (const file of impactedFiles) {
    console.log(`  ${file.path} (${file.language})`);
  }
}

function printSymbolRows(title: string, symbols: GraphSymbol[]): void {
  console.log(`${title} (${symbols.length})`);
  if (symbols.length === 0) {
    console.log("  none");
    return;
  }
  for (const symbol of symbols) {
    console.log(`  ${symbol.name.padEnd(24)} ${symbol.kind.padEnd(10)} ${symbol.filePath}`);
  }
}
