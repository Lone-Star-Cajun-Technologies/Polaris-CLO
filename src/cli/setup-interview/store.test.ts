import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

// Mock node:fs so tests don't touch real disk
vi.mock("node:fs");

import {
  loadInterview,
  saveInterview,
  loadOrCreate,
  applyAnswers,
  markApproved,
  nextUnansweredQuestion,
} from "./store.js";
import { createInterviewRecord } from "./schema.js";

const REPO_ROOT = "/fake-repo";
const INTERVIEW_PATH = `${REPO_ROOT}/.polaris/setup/interview.json`;

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── loadInterview ─────────────────────────────────────────────────────────────

describe("loadInterview", () => {
  it("returns null when file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadInterview(REPO_ROOT)).toBeNull();
  });

  it("returns null when file is malformed JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not-json");
    expect(loadInterview(REPO_ROOT)).toBeNull();
  });

  it("returns the parsed record when the file is valid", () => {
    const record = createInterviewRecord(new Date("2024-01-01T00:00:00Z"));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(record));
    expect(loadInterview(REPO_ROOT)).toEqual(record);
  });
});

// ─── saveInterview ─────────────────────────────────────────────────────────────

describe("saveInterview", () => {
  it("writes the record as pretty-printed JSON with trailing newline", () => {
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    const record = createInterviewRecord(new Date("2024-01-01T00:00:00Z"));
    saveInterview(REPO_ROOT, record);

    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    const [path, content] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
    expect(path).toBe(INTERVIEW_PATH);
    expect(content).toBe(`${JSON.stringify(record, null, 2)}\n`);
  });

  it("creates parent directories before writing", () => {
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    saveInterview(REPO_ROOT, createInterviewRecord());

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      `${REPO_ROOT}/.polaris/setup`,
      { recursive: true },
    );
  });
});

// ─── round-trip ────────────────────────────────────────────────────────────────

describe("round-trip", () => {
  it("loadInterview restores what saveInterview wrote", () => {
    const record = createInterviewRecord(new Date("2024-06-01T00:00:00Z"));
    let stored = "";
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockImplementation((_p, data) => {
      stored = data as string;
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => stored);

    saveInterview(REPO_ROOT, record);
    const loaded = loadInterview(REPO_ROOT);
    expect(loaded).toEqual(record);
  });
});

// ─── loadOrCreate ──────────────────────────────────────────────────────────────

describe("loadOrCreate", () => {
  it("returns a new record when no file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const now = new Date("2025-01-01T00:00:00Z");
    const record = loadOrCreate(REPO_ROOT, now);
    expect(record.status).toBe("in-progress");
    expect(record.started_at).toBe(now.toISOString());
  });

  it("returns the existing record when a file exists", () => {
    const existing = createInterviewRecord(new Date("2024-01-01T00:00:00Z"));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing));
    expect(loadOrCreate(REPO_ROOT)).toEqual(existing);
  });
});

// ─── applyAnswers ──────────────────────────────────────────────────────────────

describe("applyAnswers", () => {
  it("merges new answers without losing existing ones", () => {
    const base = { ...createInterviewRecord(), answers: { project_purpose: "my app" } };
    const updated = applyAnswers(base, { source_roots: ["src/"] });
    expect(updated.answers.project_purpose).toBe("my app");
    expect(updated.answers.source_roots).toEqual(["src/"]);
  });

  it("transitions status from in-progress to answered", () => {
    const base = createInterviewRecord();
    expect(base.status).toBe("in-progress");
    const updated = applyAnswers(base, { project_purpose: "x" });
    expect(updated.status).toBe("answered");
  });

  it("does not downgrade status from approved", () => {
    const base = { ...createInterviewRecord(), status: "approved" as const };
    const updated = applyAnswers(base, { project_purpose: "y" });
    expect(updated.status).toBe("approved");
  });
});

// ─── markApproved ──────────────────────────────────────────────────────────────

describe("markApproved", () => {
  it("sets status to approved and records approved_at", () => {
    const record = createInterviewRecord();
    const now = new Date("2025-06-01T12:00:00Z");
    const approved = markApproved(record, now);
    expect(approved.status).toBe("approved");
    expect(approved.approved_at).toBe(now.toISOString());
  });

  it("does not mutate the original record", () => {
    const record = createInterviewRecord();
    markApproved(record);
    expect(record.status).toBe("in-progress");
    expect(record.approved_at).toBeNull();
  });
});

// ─── nextUnansweredQuestion ────────────────────────────────────────────────────

describe("nextUnansweredQuestion", () => {
  it("returns the first unanswered required question", () => {
    const record = { ...createInterviewRecord(), answers: { project_purpose: "app" } };
    expect(nextUnansweredQuestion(record)).toBe("source_roots");
  });

  it("returns null when all required questions are answered", () => {
    const record = {
      ...createInterviewRecord(),
      answers: {
        project_purpose: "app",
        source_roots: ["src/"],
        languages: ["typescript"],
        canonical_doc_folders: ["docs/"],
        never_touch: [],
        providers_by_role: { foreman: "devin" },
      },
    };
    expect(nextUnansweredQuestion(record)).toBeNull();
  });

  it("returns project_purpose for a fresh record", () => {
    expect(nextUnansweredQuestion(createInterviewRecord())).toBe("project_purpose");
  });
});
