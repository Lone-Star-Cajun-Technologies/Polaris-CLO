import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RepoScanInventory } from "./adoption-plan.js";

export interface GeneratePolarisRulesOptions {
  overwrite?: boolean;
  /** Path to the workspace template directory (contains POLARIS_RULES.md). */
  workspaceDir?: string;
}

export interface RefreshResult {
  status: "updated" | "skipped";
  path: string;
}

function buildRepoOverview(inventory: RepoScanInventory): string {
  const notes = inventory.architecture_notes.filter(Boolean);
  const roots = inventory.source_roots.filter(Boolean);
  const lines: string[] = [];

  if (notes.length > 0) {
    lines.push(notes.slice(0, 3).join(" "));
  } else if (roots.length > 0) {
    lines.push(`Source roots: ${roots.slice(0, 4).join(", ")}.`);
  }

  return lines.join(" ").trim() || "Repository managed by Polaris.";
}

function buildContentFromTemplate(templatePath: string, overview: string): string {
  const template = readFileSync(templatePath, "utf-8");
  return template.replace("{{REPO_OVERVIEW}}", overview);
}

function buildContentInline(overview: string): string {
  return [
    "# Polaris Rules",
    "",
    "> This file is the single shared governance source for this Polaris-managed repository.",
    "> Agent files (AGENTS.md, CLAUDE.md, etc.) are pointers to this file.",
    "> This file is SmartDocs-ignored — it is bootstrap governance, not doctrine.",
    "",
    "## Repository Overview",
    "",
    overview,
    "",
    "---",
    "",
    "## Temporary Worker Doctrine",
    "",
    "Every model instance is a temporary occupant of a durable role. Roles persist; model",
    "instances are disposable.",
    "",
    "A worker should arrive at a task knowing only:",
    "- what job it is doing",
    "- what files it may touch",
    "- what route governs the work",
    "- what validation proves completion",
    "",
    "If a worker requires broad repository context, the cognition structure has failed — not",
    "the worker.",
    "",
    "---",
    "",
    "## Repository Memory Doctrine",
    "",
    "Polaris stores institutional memory in repository artifacts rather than model memory.",
    "Knowledge should be discoverable through navigation, route cognition, SmartDocs,",
    "summaries, commits, telemetry, and runtime artifacts.",
    "",
    "Workers should not rely on persistent model memory to perform assigned work.",
    "",
    "---",
    "",
    "## Navigation Before Retrieval",
    "",
    "Links are retrieval paths, not reading assignments.",
    "",
    "Workers should not read doctrine, charts, or supporting documents merely because they",
    "exist.",
    "",
    "Expected behavior:",
    "1. Attempt work",
    "2. Encounter problem",
    "3. Check local guidance",
    "4. Match symptom",
    "5. Retrieve relevant artifact",
    "6. Continue",
    "",
    "Never preload all linked documents.",
    "Never load all doctrine.",
    "Never load all charts.",
    "",
    "Navigation precedes retrieval.",
    "Retrieval precedes loading.",
    "",
    "---",
    "",
    "## Skill Command Routing",
    "",
    "When a Polaris skill command is received, load the skill packet before any other action.",
    "Full routing table: `.polaris/skills/ROUTING.md`",
    "",
    "Recognized command forms use `<CLUSTER-ID>` as the work identifier:",
    "",
    "- `polaris-analyze <CLUSTER-ID>` / `run polaris-analyze on [issue] <CLUSTER-ID>`",
    "- `polaris-run <CLUSTER-ID>` / `run polaris-run on [issue] <CLUSTER-ID>`",
    "- `polaris-finalize` / `run polaris-finalize`",
    "- `polaris-status` / `run polaris-status`",
    "- `docs-ingest` / `run docs-ingest`",
    "- `docs-review` / `run docs-review`",
    "- `docs-triage` / `run docs-triage`",
    "- `polaris-reconcile <CLUSTER-ID>` / `run polaris-reconcile on [issue] <CLUSTER-ID>`",
    "- `polaris-catalog <CLUSTER-ID>` / `run polaris-catalog on [issue] <CLUSTER-ID>`",
    "",
    "When a recognized command is received:",
    "1. Look up the target skill in `.polaris/skills/ROUTING.md`",
    "2. Read `.polaris/skills/<target-skill>/SKILL.md` first — before any repo inspection",
    "3. Run the bootloader command to obtain the runtime packet",
    "4. Execute the skill's `chain.md` in strict step order",
    "",
    "---",
    "",
    "## Map-Query Rule",
    "",
    "The map is runtime infrastructure. Query results are model context.",
    "",
    "**Agents may query the map. Agents may not consume map artifacts.**",
    "",
    "Use:",
    "```",
    "polaris map query <path>",
    "```",
    "",
    "Never read these files directly:",
    "- `.polaris/map/file-routes.json`",
    "- `.polaris/map/index.json`",
    "- `.polaris/map/needs-review.json`",
    "",
    "These paths appear only in prohibition lists.",
    "",
    "---",
    "",
    "## Graph Navigation",
    "",
    "Polaris maintains a code-intelligence graph for this repository.",
    "Use Polaris graph commands as the primary code-intelligence path.",
    "Fall back to `rg` (ripgrep) and direct file inspection when the graph is unavailable.",
    "",
    "Primary commands:",
    "```",
    "polaris graph build",
    "polaris graph query <symbol-or-file>",
    "polaris graph impact <symbol-or-file>",
    "polaris map query <path>",
    "```",
    "",
    "Fallback (graph unavailable):",
    "- `rg <pattern>` for symbol and pattern search",
    "- Direct file inspection for structure and content",
    "",
    "Never prefer an external repo-analysis tool over Polaris graph for Polaris-managed repos.",
    "",
    "---",
    "",
    "## Tracker-Agnostic Work Intake",
    "",
    "Work identifiers are opaque to the model. Polaris is tracker-agnostic.",
    "",
    "Work may originate from Linear, GitHub, a SmartDocs spec, a local work contract,",
    "a manual prompt, or a future provider. The runtime resolves identifiers.",
    "The model does not interpret or construct cluster identifiers.",
    "",
    "---",
    "",
    "## Runtime Boundaries",
    "",
    "- Resolve execution state before beginning work",
    "- Follow the active cluster and child ordering",
    "- Execute only the currently assigned child",
    "- Do not expand scope outside the assigned child",
    "- If blocked, stop and report the unblock condition",
    "- Foreman orchestrates; Worker implements; Librarian reconciles",
    "- A provider may occupy multiple roles, but role authority does not merge",
    "",
    "---",
    "",
    "## Canon Discovery",
    "",
    "Project canon is route-local.",
    "",
    "Use:",
    "- `POLARIS.md` in the relevant route folder for operational guidance",
    "- `SUMMARY.md` in the relevant route folder for informational context",
    "- `polaris map query <path>` for route and ownership resolution",
    "- Runtime state artifacts for execution state and resume handling",
    "",
    "Do not assume global repository context unless explicitly provided by the runtime.",
    "",
  ].join("\n");
}

export function extractRepoOverview(content: string): string {
  const match = content.match(/(?:^|\n)## Repository Overview\r?\n([\s\S]*?)(?:\r?\n## |$)/);
  if (!match) return "Repository managed by Polaris.";
  const overview = match[1].trim().replace(/(^|\n)---\s*$/, "").trim();
  return overview || "Repository managed by Polaris.";
}

export function refreshPolarisRules(
  repoRoot: string,
  currentVersion: string,
): RefreshResult {
  const outputPath = join(repoRoot, "POLARIS_RULES.md");

  let content = "";
  if (existsSync(outputPath)) {
    content = readFileSync(outputPath, "utf-8");
  }

  const firstLine = content.split(/\r?\n/)[0] ?? "";
  const versionMatch = firstLine.match(/^<!-- polaris-version: ([\d.]+-?[\w.]*) -->$/);
  const existingVersion = versionMatch?.[1];

  if (existingVersion === currentVersion) {
    return { status: "skipped", path: outputPath };
  }

  const overview = extractRepoOverview(content);
  const newContent = `<!-- polaris-version: ${currentVersion} -->\n${buildContentInline(overview)}`;

  const dir = dirname(outputPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, newContent, "utf-8");

  return { status: "updated", path: outputPath };
}

export async function generatePolarisRules(
  repoRoot: string,
  inventory: RepoScanInventory,
  options: GeneratePolarisRulesOptions = {},
): Promise<void> {
  const { overwrite = false, workspaceDir } = options;
  const outputPath = join(repoRoot, "POLARIS_RULES.md");

  if (existsSync(outputPath) && !overwrite) {
    return;
  }

  const overview = buildRepoOverview(inventory);

  let content: string;
  const templatePath = workspaceDir ? join(workspaceDir, "POLARIS_RULES.md") : undefined;
  if (templatePath && existsSync(templatePath)) {
    content = buildContentFromTemplate(templatePath, overview);
  } else {
    content = buildContentInline(overview);
  }

  const dir = dirname(outputPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, content, "utf-8");
}
