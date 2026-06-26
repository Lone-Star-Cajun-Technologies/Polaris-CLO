import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createInterviewRecord,
  type InterviewAnswers,
  type InterviewRecord,
  type InterviewStatus,
} from "./schema.js";

function interviewPath(repoRoot: string): string {
  return join(repoRoot, ".polaris", "setup", "interview.json");
}

/**
 * Load an existing interview record from disk.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function loadInterview(repoRoot: string): InterviewRecord | null {
  const path = interviewPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as InterviewRecord;
  } catch {
    return null;
  }
}

/** Persist an interview record to .polaris/setup/interview.json. */
export function saveInterview(repoRoot: string, record: InterviewRecord): void {
  const path = interviewPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

/**
 * Load an existing record or create a fresh one.
 * Supports --resume: caller passes the return value to continueInterview.
 */
export function loadOrCreate(repoRoot: string, now = new Date()): InterviewRecord {
  return loadInterview(repoRoot) ?? createInterviewRecord(now);
}

/** Merge new answers into the record and transition status to "answered" if appropriate. */
export function applyAnswers(
  record: InterviewRecord,
  answers: Partial<InterviewAnswers>,
): InterviewRecord {
  return {
    ...record,
    answers: { ...record.answers, ...answers },
    status: record.status === "approved" ? "approved" : "answered",
  };
}

/** Transition record to "approved" status, recording the approval timestamp. */
export function markApproved(record: InterviewRecord, now = new Date()): InterviewRecord {
  return {
    ...record,
    status: "approved" as InterviewStatus,
    approved_at: now.toISOString(),
  };
}

/**
 * Return the next unanswered required question key, or null if all are answered.
 * Used to resume at the right question after a partial run.
 */
export function nextUnansweredQuestion(
  record: InterviewRecord,
): keyof InterviewAnswers | null {
  const required: Array<keyof InterviewAnswers> = [
    "project_purpose",
    "source_roots",
    "languages",
    "canonical_doc_folders",
    "never_touch",
    "providers_by_role",
  ];
  return required.find((key) => record.answers[key] === undefined) ?? null;
}
