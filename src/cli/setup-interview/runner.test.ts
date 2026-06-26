import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

// Mock node:fs so tests don't touch real disk
vi.mock("node:fs");

import { runInterview } from "./runner.js";
import { createInterviewRecord } from "./schema.js";

const REPO_ROOT = "/fake-repo";

/** Build a readline mock that returns answers in order. */
function makeRl(answers: string[]) {
  const queue = [...answers];
  return {
    question: vi.fn((_prompt: string) => Promise.resolve(queue.shift() ?? "")),
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
});

// ─── Already-complete record ────────────────────────────────────────────────

describe("runInterview — already complete", () => {
  it("returns immediately when all questions are answered", async () => {
    const complete = {
      ...createInterviewRecord(),
      answers: {
        project_purpose: "done",
        source_roots: ["src"],
        languages: ["ts"],
        canonical_doc_folders: ["docs"],
        never_touch: [],
        providers_by_role: {},
      },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(complete));

    const rl = makeRl([]);
    const result = await runInterview(REPO_ROOT, { rl });
    expect(rl.question).not.toHaveBeenCalled();
    expect(result.answers.project_purpose).toBe("done");
  });
});

// ─── Non-interactive guard ──────────────────────────────────────────────────

describe("runInterview — non-interactive guard", () => {
  it("throws a clear error when nonInteractive is true and questions remain", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(runInterview(REPO_ROOT, { nonInteractive: true })).rejects.toThrow(
      "polaris init: interview requires an interactive terminal.",
    );
  });
});

// ─── Full run ───────────────────────────────────────────────────────────────

describe("runInterview — full run", () => {
  it("asks all 6 questions and saves after each answer", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const rl = makeRl([
      "My project",          // project_purpose
      "src, lib",            // source_roots
      "typescript",          // languages
      "docs",                // canonical_doc_folders
      "",                    // never_touch (blank → [])
      "foreman:devin",       // providers_by_role
    ]);

    const result = await runInterview(REPO_ROOT, { rl });

    expect(rl.question).toHaveBeenCalledTimes(6);
    expect(rl.close).toHaveBeenCalledOnce();

    expect(result.answers.project_purpose).toBe("My project");
    expect(result.answers.source_roots).toEqual(["src", "lib"]);
    expect(result.answers.languages).toEqual(["typescript"]);
    expect(result.answers.canonical_doc_folders).toEqual(["docs"]);
    expect(result.answers.never_touch).toEqual([]);
    expect(result.answers.providers_by_role).toEqual({ foreman: "devin" });

    // Saved after each answer = 6 writes
    expect(fs.writeFileSync).toHaveBeenCalledTimes(6);
  });

  it("closes readline even when a question rejects", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const rl = {
      question: vi.fn().mockRejectedValue(new Error("stdin closed")),
      close: vi.fn(),
    };

    await expect(runInterview(REPO_ROOT, { rl })).rejects.toThrow("stdin closed");
    expect(rl.close).toHaveBeenCalledOnce();
  });
});

// ─── Resume ─────────────────────────────────────────────────────────────────

describe("runInterview — resume", () => {
  it("skips already-answered questions and asks only the remaining ones", async () => {
    const partial = {
      ...createInterviewRecord(),
      answers: {
        project_purpose: "existing purpose",
        source_roots: ["src"],
      },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(partial));

    // 4 remaining questions: languages, canonical_doc_folders, never_touch, providers_by_role
    const rl = makeRl(["typescript", "docs", "", ""]);

    const result = await runInterview(REPO_ROOT, { rl });

    expect(rl.question).toHaveBeenCalledTimes(4);
    expect(result.answers.project_purpose).toBe("existing purpose");
    expect(result.answers.source_roots).toEqual(["src"]);
    expect(result.answers.languages).toEqual(["typescript"]);
  });
});
