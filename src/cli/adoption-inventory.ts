import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  AgentInstructionFile,
  RepoScanInventory,
  SmartDocsCandidate,
} from "./adoption-plan.js";

interface RepoEntry {
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
}

export interface ScanAdoptionInventoryOptions {
  now?: Date;
  writeArtifact?: boolean;
}

const SOURCE_ROOT_HINTS = ["src", "lib", "app", "packages", "services", "server", "client"];
const DOC_ROOT_HINTS = [
  "docs",
  "doc",
  "wiki",
  "adr",
  "rfcs",
  "architecture",
  "design",
  "spec",
  "specs",
  "guides",
];
const GENERATED_ROOT_HINTS = ["dist", "build", "coverage", ".next", ".nuxt", "out", "generated"];
const CACHE_ROOT_HINTS = [".cache", ".turbo", ".parcel-cache", ".vite", "tmp", ".tmp"];
const FIXTURE_ROOT_HINTS = ["fixtures", "__fixtures__", "__mocks__", "test/data", "tests/data"];

const SKIP_TRAVERSAL = new Set([".git", "node_modules"]);

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function withTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function detectPackageManager(repoRoot: string): RepoScanInventory["package_manager"] {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoRoot, "bun.lockb")) || existsSync(join(repoRoot, "bun.lock"))) return "bun";
  if (existsSync(join(repoRoot, "package-lock.json")) || existsSync(join(repoRoot, "npm-shrinkwrap.json"))) {
    return "npm";
  }
  if (existsSync(join(repoRoot, "package.json"))) return "npm";
  return null;
}

function detectRepoState(repoRoot: string, topLevelEntries: RepoEntry[]): RepoScanInventory["repo_state"] {
  if (existsSync(join(repoRoot, ".polaris"))) {
    return "polaris-enabled";
  }

  const meaningfulEntries = topLevelEntries.filter(
    (entry) => entry.path !== ".git" && entry.path !== ".gitignore",
  );

  if (meaningfulEntries.length === 0) {
    return "empty";
  }

  const hasManifest = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"].some((file) =>
    existsSync(join(repoRoot, file)),
  );
  const hasSourceRoots = topLevelEntries.some((entry) => SOURCE_ROOT_HINTS.includes(entry.path));
  const hasDocsRoots = topLevelEntries.some((entry) => DOC_ROOT_HINTS.includes(entry.path));

  if (hasManifest && !hasSourceRoots && !hasDocsRoots) {
    return "new";
  }

  if (!hasManifest && (hasSourceRoots || hasDocsRoots)) {
    return "partial";
  }

  return "existing";
}

function walkRepository(repoRoot: string, relativeDir = ""): RepoEntry[] {
  const currentDir = join(repoRoot, relativeDir);
  let names: string[] = [];
  try {
    names = readdirSync(currentDir);
  } catch {
    return [];
  }

  const entries: RepoEntry[] = [];

  for (const name of names) {
    const relPath = relativeDir ? `${relativeDir}/${name}` : name;
    const absPath = join(repoRoot, relPath);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    const normalizedPath = toPosix(relPath);
    const repoEntry: RepoEntry = {
      path: normalizedPath,
      isDirectory: stat.isDirectory(),
      sizeBytes: stat.size,
    };
    entries.push(repoEntry);

    if (repoEntry.isDirectory && !SKIP_TRAVERSAL.has(name)) {
      entries.push(...walkRepository(repoRoot, normalizedPath));
    }
  }

  return entries;
}

function detectRoots(entries: RepoEntry[], hints: string[]): string[] {
  const roots = entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.path)
    .filter((path) => hints.some((hint) => path === hint || path.includes(`/${hint}/`) || path.endsWith(`/${hint}`)))
    .map(withTrailingSlash);

  return uniqueSorted(roots);
}

function parsePackageScripts(repoRoot: string): Record<string, string> {
  const packageJsonPath = join(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.scripts).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function buildScriptCommands(scripts: Record<string, string>, mode: "test" | "build"): string[] {
  const matchers =
    mode === "test"
      ? [/^test$/i, /test/i, /e2e/i, /integration/i]
      : [/^build$/i, /build/i, /compile/i, /typecheck/i];

  const commands: string[] = [];
  for (const scriptName of Object.keys(scripts)) {
    if (!matchers.some((matcher) => matcher.test(scriptName))) {
      continue;
    }

    if (scriptName === "test") {
      commands.push("npm test");
    } else {
      commands.push(`npm run ${scriptName}`);
    }
  }

  return uniqueSorted(commands);
}

interface InstructionPattern {
  matcher: (entry: RepoEntry) => boolean;
  provider: AgentInstructionFile["provider"];
}

const INSTRUCTION_PATTERNS: InstructionPattern[] = [
  {
    matcher: (entry) => entry.path === "CLAUDE.md",
    provider: "claude",
  },
  {
    matcher: (entry) => entry.path === "AGENTS.md",
    provider: "openai",
  },
  {
    matcher: (entry) => entry.path === ".github/copilot-instructions.md",
    provider: "copilot",
  },
  {
    matcher: (entry) => entry.path === ".cursorrules" || entry.path.startsWith(".cursor/rules/"),
    provider: "cursor",
  },
  {
    matcher: (entry) => entry.path === ".aider.conf.yml" || entry.path === "AIDER.md",
    provider: "aider",
  },
  {
    matcher: (entry) => basename(entry.path) === "GEMINI.md",
    provider: "gemini",
  },
];

function recommendationForInstruction(
  hasDelegation: boolean,
  doctrineExists: boolean,
  sizeBytes: number,
): Pick<AgentInstructionFile, "recommendation" | "reason"> {
  if (hasDelegation) {
    return {
      recommendation: "preserve",
      reason: "Already delegates to Polaris doctrine.",
    };
  }

  if (!doctrineExists) {
    return {
      recommendation: "preserve",
      reason: "No POLARIS.md doctrine detected yet.",
    };
  }

  if (sizeBytes < 500) {
    return {
      recommendation: "thin-adapter",
      reason: "Short generic instruction file; convert to thin adapter.",
    };
  }

  return {
    recommendation: "migrate",
    reason: "Substantive instruction file should be preserved in SmartDocs raw migration.",
  };
}

function detectAgentInstructionFiles(
  repoRoot: string,
  entries: RepoEntry[],
  doctrineExists: boolean,
): AgentInstructionFile[] {
  return entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => {
      const matched = INSTRUCTION_PATTERNS.find((pattern) => pattern.matcher(entry));
      if (!matched) {
        return null;
      }

      const content = safeRead(join(repoRoot, entry.path));
      const hasPolarisDelegation =
        content.includes("<!-- polaris:delegate") || content.toLowerCase().includes("polaris.md");
      const recommendation = recommendationForInstruction(
        hasPolarisDelegation,
        doctrineExists,
        entry.sizeBytes,
      );

      return {
        path: entry.path,
        provider: matched.provider,
        size_bytes: entry.sizeBytes,
        has_polaris_delegation: hasPolarisDelegation,
        recommendation: recommendation.recommendation,
        reason: recommendation.reason,
      } satisfies AgentInstructionFile;
    })
    .filter((entry): entry is AgentInstructionFile => entry !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function classifyDocKind(path: string): SmartDocsCandidate["kind"] {
  const lowered = path.toLowerCase();
  if (lowered.includes("spec")) return "spec";
  if (lowered.includes("adr") || lowered.includes("decision")) return "decision";
  if (lowered.includes("arch") || lowered.includes("design")) return "architecture";
  if (lowered.includes("integration")) return "integration";
  if (lowered.includes("doc") || lowered.endsWith(".md") || lowered.endsWith(".mdx")) return "doc";
  return "unknown";
}

function shouldSkipDoc(path: string): boolean {
  const lowered = path.toLowerCase();
  const filename = basename(lowered);
  if (
    lowered.startsWith("smartdocs/") ||
    lowered.startsWith("node_modules/") ||
    lowered.startsWith(".git/") ||
    lowered.startsWith("dist/") ||
    lowered.startsWith("build/") ||
    lowered.startsWith("coverage/") ||
    lowered.startsWith(".next/") ||
    lowered.startsWith(".nuxt/") ||
    lowered.startsWith("out/") ||
    lowered.startsWith("generated/") ||
    lowered.startsWith(".cache/") ||
    lowered.startsWith(".turbo/") ||
    lowered.startsWith("fixtures/") ||
    lowered.includes("/fixtures/") ||
    lowered.includes("/__fixtures__/") ||
    lowered.includes("/test/data/") ||
    lowered.includes("/tests/data/")
  ) {
    return true;
  }

  if (
    filename === "agents.md" ||
    filename === "claude.md" ||
    filename === "gemini.md" ||
    filename === "aider.md" ||
    lowered === ".github/copilot-instructions.md"
  ) {
    return true;
  }

  return ["README.md", "CHANGELOG.md", "LICENSE", "CONTRIBUTING.md"].includes(path);
}

function detectSmartDocsCandidates(repoRoot: string, entries: RepoEntry[]): SmartDocsCandidate[] {
  const docs = entries
    .filter((entry) => !entry.isDirectory)
    .filter((entry) => entry.path.endsWith(".md") || entry.path.endsWith(".mdx"))
    .filter((entry) => entry.sizeBytes > 100)
    .filter((entry) => !shouldSkipDoc(entry.path))
    .map((entry) => {
      const content = safeRead(join(repoRoot, entry.path));
      const filename = basename(entry.path);
      const hasFrontmatter = content.startsWith("---\n") || content.startsWith("---\r\n");
      const kind = classifyDocKind(entry.path);

      const estimatedRisk: SmartDocsCandidate["estimated_risk"] =
        kind === "architecture" || kind === "decision" ? "medium" : "low";

      return {
        path: entry.path,
        kind,
        suggested_destination: `smartdocs/raw/${filename}`,
        confidence: hasFrontmatter ? 0.95 : 0.7,
        has_frontmatter: hasFrontmatter,
        estimated_risk: estimatedRisk,
      } satisfies SmartDocsCandidate;
    });

  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function detectArchitectureNotes(entries: RepoEntry[]): string[] {
  return uniqueSorted(
    entries
      .filter((entry) => !entry.isDirectory)
      .filter((entry) => entry.path.endsWith(".md") || entry.path.endsWith(".mdx"))
      .map((entry) => entry.path)
      .filter((path) => {
        const lowered = path.toLowerCase();
        return (
          lowered.includes("adr") || lowered.includes("rfc") || lowered.includes("architecture") || lowered.includes("design")
        );
      }),
  );
}

function detectExistingSmartDocsDirs(entries: RepoEntry[]): string[] {
  return uniqueSorted(
    entries
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.path)
      .filter((path) => path === "smartdocs" || path.startsWith("smartdocs/"))
      .map(withTrailingSlash),
  );
}

function detectLikelyCanonicalFolders(sourceRoots: string[], docsRoots: string[]): string[] {
  const folders = [...sourceRoots, ...docsRoots]
    .map((path) => path.slice(0, -1))
    .filter((path) => path !== "smartdocs" && !path.includes("fixtures"));

  return uniqueSorted(folders);
}

function detectIgnoreCandidates(generatedRoots: string[], cacheRoots: string[]): string[] {
  return uniqueSorted([...generatedRoots, ...cacheRoots, ".taskchain_artifacts/"]);
}

export function scanAdoptionInventory(
  repoRoot: string,
  options: ScanAdoptionInventoryOptions = {},
): RepoScanInventory {
  const now = options.now ?? new Date();
  const allEntries = walkRepository(repoRoot);
  const topLevelEntries = allEntries.filter((entry) => !entry.path.includes("/"));

  const packageScripts = parsePackageScripts(repoRoot);
  const sourceRoots = detectRoots(topLevelEntries, SOURCE_ROOT_HINTS);
  const docsRoots = detectRoots(topLevelEntries, DOC_ROOT_HINTS);
  const generatedRoots = detectRoots(allEntries, GENERATED_ROOT_HINTS);
  const cacheRoots = detectRoots(allEntries, CACHE_ROOT_HINTS);
  const fixtureRoots = detectRoots(allEntries, FIXTURE_ROOT_HINTS);
  const doctrineExists = existsSync(join(repoRoot, "POLARIS.md"));

  const inventory: RepoScanInventory = {
    scan_date: now.toISOString(),
    repo_state: detectRepoState(repoRoot, topLevelEntries),
    package_manager: detectPackageManager(repoRoot),
    source_roots: sourceRoots,
    docs_roots: docsRoots,
    test_commands: buildScriptCommands(packageScripts, "test"),
    build_commands: buildScriptCommands(packageScripts, "build"),
    package_scripts: packageScripts,
    generated_roots: generatedRoots,
    cache_roots: cacheRoots,
    fixture_roots: fixtureRoots,
    agent_instruction_files: detectAgentInstructionFiles(repoRoot, allEntries, doctrineExists),
    existing_smartdocs_dirs: detectExistingSmartDocsDirs(allEntries),
    architecture_notes: detectArchitectureNotes(allEntries),
    likely_canonical_folders: detectLikelyCanonicalFolders(sourceRoots, docsRoots),
    smartdocs_candidates: detectSmartDocsCandidates(repoRoot, allEntries),
    ignore_candidates: detectIgnoreCandidates(generatedRoots, cacheRoots),
  };

  if (options.writeArtifact ?? true) {
    mkdirSync(join(repoRoot, ".polaris"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".polaris", "adoption-inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
      "utf-8",
    );
  }

  return inventory;
}
