/** Typed schema for .polaris/setup/interview.json */

export type InterviewStatus = "in-progress" | "answered" | "approved";

/** Operator-provided answers captured during the setup interview. */
export interface InterviewAnswers {
  project_purpose?: string;
  source_roots?: string[];
  languages?: string[];
  canonical_doc_folders?: string[];
  never_touch?: string[];
  providers_by_role?: Record<string, string>;
}

/** Preview of files to be generated, built after answers are complete. */
export interface GenerationPlan {
  targets: string[];
}

/** Persisted state for a setup interview run. */
export interface InterviewRecord {
  schema_version: "1.0";
  mode: "init";
  status: InterviewStatus;
  started_at: string;
  answers: InterviewAnswers;
  generation_plan: GenerationPlan | null;
  approved_at: string | null;
}

/** Create a fresh interview record (status: in-progress). */
export function createInterviewRecord(now = new Date()): InterviewRecord {
  return {
    schema_version: "1.0",
    mode: "init",
    status: "in-progress",
    started_at: now.toISOString(),
    answers: {},
    generation_plan: null,
    approved_at: null,
  };
}
