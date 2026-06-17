import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AdoptionPlan, RepoScanInventory } from "./adoption-plan.js";

type InstructionDecision = "preserve" | "thin-adapter" | "migrate";

export interface InstructionActionRecord {
  source_path: string;
  decision: InstructionDecision;
  reason: string;
  backup_path: string | null;
  timestamp: string;
}

const DELEGATION_MARKERS = ["<!-- polaris:delegate", "POLARIS_RULES.md", "POLARIS.md", "Polaris runtime"];

function isSupportedInstructionPath(path: string): boolean {
  return (
    path === "CLAUDE.md" ||
    path === "AGENTS.md" ||
    path === ".github/copilot-instructions.md" ||
    path === ".cursorrules" ||
    path === ".aider.conf.yml" ||
    path === "AIDER.md" ||
    /^\.cursor\/rules\/.*\.md$/i.test(path) ||
    /(^|\/)GEMINI\.md$/i.test(path)
  );
}

function hasDoctrine(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, "POLARIS_RULES.md")) ||
    existsSync(join(repoRoot, "POLARIS.md")) ||
    existsSync(join(repoRoot, "smartdocs", "doctrine", "active"))
  );
}

function hasDelegationMarker(content: string): boolean {
  return DELEGATION_MARKERS.some((marker) => content.includes(marker));
}

function classifyInstruction(
  content: string,
  doctrineExists: boolean,
  _repoHints: string[],
): { decision: InstructionDecision; reason: string } {
  if (hasDelegationMarker(content)) {
    return { decision: "preserve", reason: "already contains Polaris delegation markers" };
  }

  if (!doctrineExists) {
    return { decision: "preserve", reason: "no Polaris doctrine exists yet" };
  }

  // When POLARIS_RULES.md exists, all agent files become pointer-only.
  // Substantive content is migrated to smartdocs/raw/migrated-instructions.
  return { decision: "thin-adapter", reason: "POLARIS_RULES.md exists — convert to pointer" };
}

function toBackupFileName(sourcePath: string): string {
  const cleaned = sourcePath.replace(/^\.+\//, "").replaceAll("/", "__");
  return cleaned.length > 0 ? cleaned : basename(sourcePath);
}

function reserveBackupPath(baseDirectory: string, sourcePath: string): string {
  const baseName = toBackupFileName(sourcePath);
  let candidate = join(baseDirectory, baseName);
  if (!existsSync(candidate)) {
    return candidate;
  }

  const dotIndex = baseName.lastIndexOf(".");
  const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const ext = dotIndex > 0 ? baseName.slice(dotIndex) : "";

  let index = 1;
  while (existsSync(candidate)) {
    candidate = join(baseDirectory, `${stem}-${index}${ext}`);
    index += 1;
  }

  return candidate;
}

function preserveOriginalContent(
  repoRoot: string,
  sourcePath: string,
  content: string,
): string {
  const archiveRoot = join(repoRoot, "smartdocs", "raw", "migrated-instructions");
  mkdirSync(archiveRoot, { recursive: true });

  const backupPath = reserveBackupPath(archiveRoot, sourcePath);
  writeFileSync(backupPath, content, "utf-8");

  const roundTrip = readFileSync(backupPath, "utf-8");
  if (roundTrip !== content) {
    throw new Error(`Failed to preserve original instruction content for ${sourcePath}`);
  }

  return backupPath;
}

function buildThinAdapter(_sourcePath: string): string {
  return [
    "# Polaris Managed Repository",
    "",
    "Read [POLARIS_RULES.md](POLARIS_RULES.md) before doing any work in this repository.",
    "",
  ].join("\n");
}

function appendInstructionProvenance(
  repoRoot: string,
  records: InstructionActionRecord[],
): void {
  if (records.length === 0) {
    return;
  }

  const provenancePath = join(repoRoot, ".polaris", "adoption-provenance.json");
  mkdirSync(join(repoRoot, ".polaris"), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(provenancePath)) {
    try {
      const parsed = JSON.parse(readFileSync(provenancePath, "utf-8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const prior = Array.isArray(existing.instruction_file_actions)
    ? (existing.instruction_file_actions as unknown[])
    : [];

  const updated = {
    ...existing,
    updated_at: new Date().toISOString(),
    instruction_file_actions: [...prior, ...records],
  };

  writeFileSync(provenancePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}

export function handleInstructionFiles(
  plan: AdoptionPlan,
  inventory: RepoScanInventory,
  repoRoot: string,
): Promise<InstructionActionRecord[]> {
  if (plan.dry_run) {
    return Promise.resolve([]);
  }
  const doctrineExists = hasDoctrine(repoRoot);
  const now = new Date().toISOString();

  const candidates = Array.from(
    new Set(
      inventory.agent_instruction_files
        .map((entry) => entry.path)
        .filter((path) => isSupportedInstructionPath(path)),
    ),
  );

  const provenance: InstructionActionRecord[] = [];

  for (const relativePath of candidates) {
    const absolutePath = join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const originalContent = readFileSync(absolutePath, "utf-8");
    const { decision, reason } = classifyInstruction(originalContent, doctrineExists, []);

    if (decision === "preserve") {
      provenance.push({
        source_path: relativePath,
        decision,
        reason,
        backup_path: null,
        timestamp: now,
      });
      continue;
    }

    const backupAbsolutePath = preserveOriginalContent(repoRoot, relativePath, originalContent);
    writeFileSync(absolutePath, buildThinAdapter(relativePath), "utf-8");

    provenance.push({
      source_path: relativePath,
      decision,
      reason,
      backup_path: backupAbsolutePath.slice(repoRoot.length + 1).replaceAll("\\", "/"),
      timestamp: now,
    });
  }

  appendInstructionProvenance(repoRoot, provenance);
  return Promise.resolve(provenance);
}
