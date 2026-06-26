import { createInterface } from "node:readline/promises";
import type { InterviewAnswers, InterviewRecord } from "./schema.js";
import { loadOrCreate, saveInterview, nextUnansweredQuestion } from "./store.js";

/** One prompt entry in the question bank. */
interface Question {
  key: keyof InterviewAnswers;
  prompt: string;
  /**
   * Parse a raw answer string into the typed field value.
   * Comma-separated values become string[]; plain text stays string.
   */
  parse: (raw: string) => InterviewAnswers[keyof InterviewAnswers];
}

const QUESTION_BANK: Question[] = [
  {
    key: "project_purpose",
    prompt: "What is the purpose of this project? (one sentence)",
    parse: (raw) => raw.trim(),
  },
  {
    key: "source_roots",
    prompt: "Source root directories (comma-separated, e.g. src,lib):",
    parse: (raw) => splitCsv(raw),
  },
  {
    key: "languages",
    prompt: "Primary languages/frameworks (comma-separated, e.g. typescript,react):",
    parse: (raw) => splitCsv(raw),
  },
  {
    key: "canonical_doc_folders",
    prompt: "Canonical documentation folders (comma-separated, e.g. docs,smartdocs):",
    parse: (raw) => splitCsv(raw),
  },
  {
    key: "never_touch",
    prompt: "Paths agents should never modify (comma-separated, or leave blank):",
    parse: (raw) => splitCsv(raw),
  },
  {
    key: "providers_by_role",
    prompt: "Agent providers by role — format: role:provider,role:provider (or leave blank):",
    parse: parseProvidersByRole,
  },
];

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseProvidersByRole(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [role, provider] = pair.split(":").map((s) => s.trim());
    if (role && provider) {
      result[role] = provider;
    }
  }
  return result;
}

export interface RunInterviewOptions {
  /** Override stdin/stdout for testing. */
  rl?: {
    question: (prompt: string) => Promise<string>;
    close: () => void;
  };
  /** If true, run non-interactively — requires all answers already stored. */
  nonInteractive?: boolean;
  /** Current timestamp — for deterministic tests. */
  now?: Date;
}

/**
 * Run the setup interview for an empty/new repo.
 *
 * - Loads or creates the persisted record.
 * - Asks only unanswered questions (resume-safe).
 * - Saves after every answer.
 * - In non-interactive mode without stored answers, throws a clear error.
 *
 * Returns the final record (all questions answered) or throws.
 */
export async function runInterview(
  repoRoot: string,
  opts: RunInterviewOptions = {},
): Promise<InterviewRecord> {
  const now = opts.now ?? new Date();
  let record = loadOrCreate(repoRoot, now);

  // Check whether the interview is already complete.
  if (nextUnansweredQuestion(record) === null) {
    return record;
  }

  // Non-interactive guard: if stdin is not a TTY and no readline override, refuse.
  if (opts.nonInteractive || (!opts.rl && !process.stdin.isTTY)) {
    throw new Error(
      "polaris init: interview requires an interactive terminal.\n" +
        "Provide answers via --resume with a stored interview file, or run interactively.",
    );
  }

  const rl =
    opts.rl ??
    (() => {
      const iface = createInterface({ input: process.stdin, output: process.stdout });
      return {
        question: (prompt: string) => iface.question(prompt),
        close: () => iface.close(),
      };
    })();

  try {
    for (const q of QUESTION_BANK) {
      if (record.answers[q.key] !== undefined) {
        // Already answered — skip (resume path).
        continue;
      }

      const raw = await rl.question(`\n${q.prompt}\n> `);
      // Parse and apply — save immediately so a crash loses at most one answer.
      const parsed = q.parse(raw);
      record = {
        ...record,
        answers: { ...record.answers, [q.key]: parsed },
        status: "answered" as const,
      };
      saveInterview(repoRoot, record);
    }
  } finally {
    rl.close();
  }

  return record;
}
