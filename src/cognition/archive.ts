import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface CognitionReconciliationEntry {
  reconcile_id: string;
  run_id: string;
  reconciled_at: string;
  notes_consumed: string[];
  polaris_md_updated: boolean;
  summary_md_updated: boolean;
}

export interface CognitionPatchRejectedEntry {
  event: "cognition-librarian-patch-rejected";
  reconcile_id: string;
  run_id: string;
  rejected_at: string;
  notes_consumed: string[];
  polaris_md_updated: boolean;
  summary_md_updated: boolean;
  reason?: string;
}

export interface CognitionIndexFile {
  entries: Array<CognitionReconciliationEntry | CognitionPatchRejectedEntry>;
}

export interface ArchiveCognitionNotesOptions {
  repoRoot: string;
  reconcileId: string;
  runId: string;
  notesConsumed: string[];
  polarisMdUpdated: boolean;
  summaryMdUpdated: boolean;
  reconciledAt?: string;
  result?: unknown;
  status?: "applied" | "rejected";
  rejectionReason?: string;
}

export interface ArchiveCognitionNotesResult {
  archivedNotes: string[];
  missingNotes: string[];
  updatedIndexFiles: string[];
  resultFiles: string[];
}

const PENDING_PREFIX = ".polaris/cognition/pending/";
const ARCHIVE_PREFIX = ".polaris/cognition/archive/";

interface ResolvedNotePath {
  pendingRelativePath: string;
  archiveRelativePath: string;
  folder: string;
  noteName: string;
}

function normalizeRelativePath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function resolvePendingNotePath(repoRoot: string, notePath: string): ResolvedNotePath {
  const rawRelativePath = path.isAbsolute(notePath)
    ? path.relative(repoRoot, notePath)
    : notePath;
  const normalized = normalizeRelativePath(rawRelativePath);
  const pendingRelativePath = normalized.startsWith(PENDING_PREFIX)
    ? normalized
    : `${PENDING_PREFIX}${normalized}`;
  const noteRelativePath = pendingRelativePath.slice(PENDING_PREFIX.length);
  const folderName = path.posix.dirname(noteRelativePath);
  const folder = folderName === "." ? "" : folderName;
  const noteName = path.posix.basename(noteRelativePath);
  const archiveRelativePath = `${ARCHIVE_PREFIX}${noteRelativePath}`;

  return {
    pendingRelativePath,
    archiveRelativePath,
    folder,
    noteName,
  };
}

function readIndex(indexPath: string): CognitionIndexFile {
  if (!existsSync(indexPath)) {
    return { entries: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as Partial<CognitionIndexFile>;
    if (Array.isArray(parsed.entries)) {
      return { entries: parsed.entries };
    }
  } catch {
    // Fall through to reset malformed index files.
  }

  return { entries: [] };
}

function writeIndex(indexPath: string, entry: CognitionReconciliationEntry | CognitionPatchRejectedEntry): void {
  const index = readIndex(indexPath);
  index.entries.push(entry);
  mkdirSync(path.dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

function buildArchivedResultPayload(options: ArchiveCognitionNotesOptions): unknown {
  return options.result ?? {
    reconcile_id: options.reconcileId,
    run_id: options.runId,
    reconciled_at: options.reconciledAt ?? new Date().toISOString(),
    notes_consumed: options.notesConsumed,
    polaris_md_updated: options.polarisMdUpdated,
    summary_md_updated: options.summaryMdUpdated,
    status: options.status ?? "applied",
  };
}

export function archiveCognitionNotes(
  options: ArchiveCognitionNotesOptions,
): ArchiveCognitionNotesResult {
  const archivedNotes: string[] = [];
  const missingNotes: string[] = [];
  const updatedIndexFiles: string[] = [];
  const resultFiles: string[] = [];
  const timestamp = options.reconciledAt ?? new Date().toISOString();
  const groupedNotes = new Map<string, string[]>();
  const resolvedNotes = options.notesConsumed.map((notePath) => resolvePendingNotePath(options.repoRoot, notePath));

  for (const note of resolvedNotes) {
    const targetGroup = groupedNotes.get(note.folder) ?? [];
    groupedNotes.set(note.folder, targetGroup);

    const pendingAbsolutePath = path.join(options.repoRoot, note.pendingRelativePath);
    const archiveAbsolutePath = path.join(options.repoRoot, note.archiveRelativePath);
    mkdirSync(path.dirname(archiveAbsolutePath), { recursive: true });

    if (options.status === "rejected") {
      targetGroup.push(note.noteName);
      continue;
    }

    if (existsSync(pendingAbsolutePath)) {
      renameSync(pendingAbsolutePath, archiveAbsolutePath);
      archivedNotes.push(note.archiveRelativePath);
      targetGroup.push(note.noteName);
      continue;
    }

    if (existsSync(archiveAbsolutePath)) {
      archivedNotes.push(note.archiveRelativePath);
      targetGroup.push(note.noteName);
      continue;
    }

    missingNotes.push(note.pendingRelativePath);
  }

  if (options.status === "rejected") {
    for (const [folder, notesConsumed] of groupedNotes.entries()) {
      if (notesConsumed.length === 0) {
        continue;
      }
      const indexRelativePath = `${PENDING_PREFIX}${folder ? `${folder}/` : ""}cognition-index.json`;
      writeIndex(path.join(options.repoRoot, indexRelativePath), {
        event: "cognition-librarian-patch-rejected",
        reconcile_id: options.reconcileId,
        run_id: options.runId,
        rejected_at: timestamp,
        notes_consumed: notesConsumed,
        polaris_md_updated: options.polarisMdUpdated,
        summary_md_updated: options.summaryMdUpdated,
        reason: options.rejectionReason,
      });
      updatedIndexFiles.push(indexRelativePath);
    }

    return {
      archivedNotes,
      missingNotes,
      updatedIndexFiles,
      resultFiles,
    };
  }

  const archivedResultPayload = buildArchivedResultPayload(options);
  for (const [folder, notesConsumed] of groupedNotes.entries()) {
    if (notesConsumed.length === 0) {
      continue;
    }

    const archiveFolderRelativePath = `${ARCHIVE_PREFIX}${folder ? `${folder}/` : ""}`;
    const archiveFolderPath = path.join(options.repoRoot, archiveFolderRelativePath);
    mkdirSync(archiveFolderPath, { recursive: true });

    const resultRelativePath = `${archiveFolderRelativePath}.reconcile-${options.reconcileId}.json`;
    writeFileSync(path.join(options.repoRoot, resultRelativePath), JSON.stringify(archivedResultPayload, null, 2) + "\n", "utf-8");
    resultFiles.push(resultRelativePath);

    const indexRelativePath = `${archiveFolderRelativePath}cognition-index.json`;
    writeIndex(path.join(options.repoRoot, indexRelativePath), {
      reconcile_id: options.reconcileId,
      run_id: options.runId,
      reconciled_at: timestamp,
      notes_consumed: notesConsumed,
      polaris_md_updated: options.polarisMdUpdated,
      summary_md_updated: options.summaryMdUpdated,
    });
    updatedIndexFiles.push(indexRelativePath);
  }

  return {
    archivedNotes,
    missingNotes,
    updatedIndexFiles,
    resultFiles,
  };
}
