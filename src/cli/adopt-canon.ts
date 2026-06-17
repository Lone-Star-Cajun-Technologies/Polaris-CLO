import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { resolveLibrarianProvider } from "../smartdocs-engine/librarian-dispatch.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".polaris", "smartdocs"]);

interface DocEntry {
  path: string;
  title: string;
}

interface CanonResponse {
  relevant_docs: { path: string; title: string }[];
  summary_lines: string[];
  polaris_lines: string[];
}

function loadInventoryCanonicalFolders(repoRoot: string): string[] {
  const inventoryPath = join(repoRoot, ".polaris", "adoption-inventory.json");
  if (!existsSync(inventoryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(inventoryPath, "utf-8")) as Record<string, unknown>;
    const folders = raw["likely_canonical_folders"];
    return Array.isArray(folders) ? (folders as string[]) : [];
  } catch {
    return [];
  }
}

function scaffoldDraftSummaryFiles(repoRoot: string, canonicalFolders: string[]): void {
  for (const folder of canonicalFolders) {
    const dir = join(repoRoot, folder);
    if (!existsSync(dir)) continue;
    const summaryPath = join(dir, "SUMMARY.md");
    if (existsSync(summaryPath)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      summaryPath,
      `# ${folder}\n\n<!-- polaris:draft -->\n`,
      "utf-8",
    );
    console.log(`  Scaffolded draft SUMMARY.md: ${folder}`);
  }
}

function walkForSummaryDirs(dir: string, repoRoot: string, results: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasSummary = entries.some((e) => e.isFile() && e.name === "SUMMARY.md");
  if (hasSummary && dir !== repoRoot) {
    results.push(dir);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    walkForSummaryDirs(join(dir, entry.name), repoRoot, results);
  }
}

function listActiveDoctrineDocs(repoRoot: string): DocEntry[] {
  const activeDir = join(repoRoot, "smartdocs", "doctrine", "active");
  if (!existsSync(activeDir)) return [];

  const docs: DocEntry[] = [];
  try {
    const files = readdirSync(activeDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      const filePath = join(activeDir, f.name);
      const content = readFileSync(filePath, "utf-8");
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : f.name.replace(/\.md$/, "");
      docs.push({ path: relative(repoRoot, filePath), title });
    }
  } catch {
    // ignore
  }
  return docs;
}

function buildLinkedDocsBlock(docs: { path: string; title: string }[]): string[] {
  const lines: string[] = ["linked_docs:"];
  for (const doc of docs) {
    const path = doc.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const title = doc.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`  - path: "${path}"`);
    lines.push(`    title: "${title}"`);
  }
  return lines;
}

function injectLinkedDocs(content: string, docs: { path: string; title: string }[], summaryLines: string[]): string {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith("#"));
  if (headingIdx === -1) return content;

  const yamlLines = ["", "---", ...buildLinkedDocsBlock(docs), "---"];

  const before = lines.slice(0, headingIdx + 1);

  // If agent provided summary content, append after YAML block
  const after = summaryLines.length > 0
    ? ["", ...summaryLines]
    : lines.slice(headingIdx + 1);

  return [...before, ...yamlLines, ...after].join("\n");
}


function parseCanonResponse(text: string): CanonResponse | null {
  const trimmed = text.trim();
  const jsonLine = trimmed.split("\n").reverse().find((l) => l.trim().startsWith("{") && l.includes("relevant_docs"));
  if (jsonLine) {
    try { return JSON.parse(jsonLine) as CanonResponse; } catch { /* fall through */ }
  }
  const blockMatch = trimmed.match(/\{[\s\S]*"relevant_docs"[\s\S]*\}/);
  if (blockMatch) {
    try { return JSON.parse(blockMatch[0]) as CanonResponse; } catch { /* fall through */ }
  }
  return null;
}

// Strip flags that require worker permissions and aren't needed for reasoning-only calls.
function stripWorkerFlags(args: string[]): string[] {
  const stripped: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--permission-mode") {
      i += 2; // skip flag + value
    } else if (a === "--allowedTools") {
      i++;
      // skip all following values until next flag or "--"
      while (i < args.length && !args[i].startsWith("-") && args[i] !== "--") i++;
    } else {
      stripped.push(a);
      i++;
    }
  }
  return stripped;
}

function dispatchCanonAgent(options: {
  repoRoot: string;
  routeFolder: string;
  doctrineDocs: DocEntry[];
  providers: Record<string, { command: string; args: string[] }>;
  providerOrder: string[];
}): CanonResponse | null {
  const { repoRoot, routeFolder, doctrineDocs, providers, providerOrder } = options;
  const providerName = resolveLibrarianProvider(providers, providerOrder);
  if (!providerName) return null;

  const cfg = providers[providerName];
  const docList = doctrineDocs
    .map((d, i) => `${i + 1}. [${d.title}] path: ${d.path}`)
    .join("\n");

  const prompt = `You are a Polaris librarian generating context files for an agent work area.

Route folder: ${routeFolder}
Repo root: ${repoRoot}

Available doctrine documents:
${docList}

Generate two outputs for this route area:

1. SUMMARY.md content — a navigation index. Select relevant doctrine docs and write 2-4 lines describing what this area covers.

2. POLARIS.md content — operational instructions for agents entering this work area. Write 4-8 lines covering: what this area is responsible for, key patterns/conventions agents should follow, what to avoid, and which doctrine docs to consult for specific concerns. Be concise and directive — agents read this cold before starting work.

Respond with ONLY valid JSON on a single line:
{"relevant_docs":[{"path":"<doc path>","title":"<doc title>"}],"summary_lines":["line1","line2"],"polaris_lines":["line1","line2"]}

If no doctrine docs are relevant, return an empty array for relevant_docs.`;

  // Same dispatch pattern as dispatchLibrarianReview — pass args straight through,
  // letting the provider config (e.g. env CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0) handle auth.
  const args = (cfg.args ?? []).map((a) => (a === "{{worker_prompt}}" ? prompt : a));
  const result = spawnSync(cfg.command, stripWorkerFlags(args), {
    encoding: "utf-8",
    timeout: 120000,
    cwd: repoRoot,
  });

  if (result.error) {
    console.log(`  agent error: ${result.error.message}`);
    return null;
  }
  if (result.stderr?.trim()) {
    console.log(`  agent stderr: ${result.stderr.trim().slice(0, 200)}`);
  }

  const stdout = (result.stdout ?? "").trim();
  return parseCanonResponse(stdout);
}

export async function enrichCanonFiles(repoRoot: string): Promise<void> {
  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig(repoRoot);
  } catch {
    throw new Error(
      "polaris agent setup required: could not load polaris.config.json.\n" +
      "Run `polaris agent setup` or configure at least a foreman agent.",
    );
  }

  const providers = (config.execution?.providers ?? {}) as Record<string, { command: string; args: string[] }>;
  const librarianOrder: string[] = config.execution?.providerPolicy?.librarian?.providers ?? [];
  const foremanOrder: string[] = (config.execution?.providerPolicy as Record<string, { providers?: string[] }>)?.foreman?.providers ?? [];

  // Prefer librarian, fall back to foreman
  const providerOrder = resolveLibrarianProvider(providers, librarianOrder) != null
    ? librarianOrder
    : foremanOrder;

  if (resolveLibrarianProvider(providers, providerOrder) == null) {
    const configured = [...new Set([...librarianOrder, ...foremanOrder])];
    const msg = configured.length > 0
      ? `Configured agents (${configured.join(", ")}) are not installed on this machine.`
      : "No librarian or foreman agents are configured.";
    throw new Error(
      `polaris agent setup required: ${msg}\n` +
      "Run `polaris agent setup` to configure an available agent.",
    );
  }

  const doctrineDocs = listActiveDoctrineDocs(repoRoot);

  const canonicalFolders = loadInventoryCanonicalFolders(repoRoot);
  if (canonicalFolders.length > 0) {
    scaffoldDraftSummaryFiles(repoRoot, canonicalFolders);
  }

  const summaryDirs: string[] = [];
  walkForSummaryDirs(repoRoot, repoRoot, summaryDirs);

  let enrichedCount = 0;
  for (const dir of summaryDirs) {
    const summaryPath = join(dir, "SUMMARY.md");
    const content = readFileSync(summaryPath, "utf-8");
    if (!content.includes("<!-- polaris:draft -->")) continue;

    const routeFolder = relative(repoRoot, dir);
    console.log(`  Dispatching librarian for: ${routeFolder}`);

    const response = dispatchCanonAgent({
      repoRoot,
      routeFolder,
      doctrineDocs,
      providers,
      providerOrder,
    });

    if (!response) {
      console.log(`  ⚠ No response for ${routeFolder}, skipping`);
      continue;
    }

    writeFileSync(
      summaryPath,
      injectLinkedDocs(content, response.relevant_docs, response.summary_lines),
      "utf-8",
    );

    if ((response.polaris_lines ?? []).length > 0) {
      const polarisPath = join(dir, "POLARIS.md");
      const polarisContent = [
        `# POLARIS — ${routeFolder}`,
        "",
        ...response.polaris_lines,
        "",
      ].join("\n");
      writeFileSync(polarisPath, polarisContent, "utf-8");
    }

    enrichedCount++;
    console.log(`  ✓ Enriched ${routeFolder} with ${response.relevant_docs.length} linked docs`);
  }

  console.log(`\nEnriched ${enrichedCount} SUMMARY.md files.`);
}
