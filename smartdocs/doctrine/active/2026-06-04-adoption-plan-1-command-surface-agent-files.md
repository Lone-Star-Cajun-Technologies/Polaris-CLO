---
status: raw
created: 2026-06-04
title: "Adoption Plan 1: Command Surface & Agent File Architecture"
tags: [adoption, implementation-plan, command-surface, agent-files, polaris-rules]
spec: smartdocs/raw/2026-06-04-polaris-adoption-architecture-design.md
source: smartdocs/raw/2026-06-04-adoption-plan-1-command-surface-agent-files.md
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-06-05-006
classified-as: doctrine-candidate
linked-map-area: src/cli
ingested-at: 2026-06-05T05:21:02.223Z
---

# Adoption Plan 1: Command Surface & Agent File Architecture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all `polaris` references with `polaris` in skill files, create `POLARIS_RULES.md` generation logic, reduce agent files to pointer-only format, and update this repo's own AGENTS.md/CLAUDE.md accordingly.

**Architecture:** Skill files become provider-agnostic by referencing `polaris <command>` directly. A new `src/cli/adopt-rules.ts` module generates `POLARIS_RULES.md` as the single shared governance source. Agent files (`AGENTS.md`, `CLAUDE.md`, etc.) are reduced to a 2-line pointer. `buildThinAdapter` in `adopt-instructions.ts` is updated to emit the pointer format. `POLARIS_RULES.md` and `CODEX.md` are added to the default SmartDocs ignore list.

**Tech Stack:** TypeScript, Node.js, Vitest (test runner: `npx vitest run`), filesystem writes via `node:fs`.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `.polaris/skills/**/*.md` (all) | Replace `polaris` → `polaris` |
| Modify | `.polaris/skills/ROUTING.md` | Replace `POL-###` → `<CLUSTER-ID>` in routing table |
| Create | `src/cli/adopt-rules.ts` | `generatePolarisRules()` — write `POLARIS_RULES.md` for adopted repo |
| Create | `src/cli/adopt-rules.test.ts` | Tests for `generatePolarisRules()` |
| Modify | `src/smartdocs-engine/smartdoc-ignore.ts` | Add `POLARIS_RULES.md`, `**/POLARIS_RULES.md`, `CODEX.md`, `**/CODEX.md` to defaults |
| Modify | `src/cli/adopt-instructions.ts` | Update `buildThinAdapter()` to pointer-only format; update `classifyInstruction()` |
| Modify | `src/cli/init.ts` | Call `generatePolarisRules()` before `handleInstructionFiles` in adopt flow |
| Modify | `AGENTS.md` | Replace with pointer-only format |
| Modify | `CLAUDE.md` | Replace with pointer-only format |
| Create | `POLARIS_RULES.md` | Repo-level shared governance source for Polaris repo itself |

---

## Task 1: Replace `polaris` with `polaris` in skill files

**Files:**
- Modify: `.polaris/skills/**/*.md` (all — use bulk replace)

- [ ] **Step 1: Count the occurrences before changing**

```bash
grep -rc "npm run polaris" .polaris/skills/
```

Expected: ~15 files with matches, ~50+ total occurrences.

- [ ] **Step 2: Run the bulk replacement**

```bash
find .polaris/skills -name "*.md" -exec \
  perl -pi -e 's/polaris /polaris /g' {} \;
```

- [ ] **Step 3: Verify no occurrences remain**

```bash
grep -r "npm run polaris" .polaris/skills/
```

Expected: no output.

- [ ] **Step 4: Spot-check a few key files**

```bash
grep "polaris skill packet" .polaris/skills/polaris-run/SKILL.md
grep "polaris loop dispatch" .polaris/skills/polaris-run/chain.md
grep "polaris skill packet" .polaris/skills/polaris-analyze/SKILL.md
```

Expected: each grep returns the line with `polaris <command>` (no `npm run` prefix).

- [ ] **Step 5: Commit**

```bash
git add .polaris/skills/
git commit -m "fix(skills): replace npm run polaris with polaris command surface"
```

---

## Task 2: Update ROUTING.md — tracker-agnostic cluster ID notation

**Files:**
- Modify: `.polaris/skills/ROUTING.md`

- [ ] **Step 1: Replace `<POL-###>` with `<CLUSTER-ID>` in the routing table**

```bash
perl -pi -e 's/<POL-###>/<CLUSTER-ID>/g' .polaris/skills/ROUTING.md
```

- [ ] **Step 2: Replace inline `POL-###` examples (e.g., `POL-257`) with `<CLUSTER-ID>`**

Open `.polaris/skills/ROUTING.md`. Find and update the notation key table:

Replace:
```markdown
| `<POL-###>` | Required placeholder — substitute the actual issue ID (e.g., `POL-257`) |
```

With:
```markdown
| `<CLUSTER-ID>` | Required placeholder — substitute the actual cluster ID as resolved by the tracker adapter (e.g., `POL-257`, `GH-42`, or a local contract ID) |
```

Also update the example in step 4:
Replace: `"If the command specifies an issue ID (e.g., `POL-257`), bind exactly that issue."`
With: `"If the command specifies a cluster ID (e.g., `POL-257`), bind exactly that cluster."`

- [ ] **Step 3: Verify**

```bash
grep "POL-###" .polaris/skills/ROUTING.md
```

Expected: no output.

```bash
grep "CLUSTER-ID" .polaris/skills/ROUTING.md | head -5
```

Expected: lines showing `<CLUSTER-ID>` in the routing table.

- [ ] **Step 4: Commit**

```bash
git add .polaris/skills/ROUTING.md
git commit -m "fix(skills): replace POL-### with CLUSTER-ID for tracker agnosticism"
```

---

## Task 3: Add POLARIS_RULES.md and CODEX.md to default SmartDocs ignore list

**Files:**
- Modify: `src/smartdocs-engine/smartdoc-ignore.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/smartdocs-engine/smartdoc-ignore.test.ts` (create if it doesn't exist):

```typescript
import { describe, it, expect } from "vitest";
import { DEFAULT_SMARTDOCIGNORE_PATTERNS } from "./smartdoc-ignore.js";

describe("DEFAULT_SMARTDOCIGNORE_PATTERNS", () => {
  it("excludes POLARIS_RULES.md at repo root", () => {
    expect(DEFAULT_SMARTDOCIGNORE_PATTERNS).toContain("POLARIS_RULES.md");
  });

  it("excludes POLARIS_RULES.md in subdirectories", () => {
    expect(DEFAULT_SMARTDOCIGNORE_PATTERNS).toContain("**/POLARIS_RULES.md");
  });

  it("excludes CODEX.md at repo root", () => {
    expect(DEFAULT_SMARTDOCIGNORE_PATTERNS).toContain("CODEX.md");
  });

  it("excludes CODEX.md in subdirectories", () => {
    expect(DEFAULT_SMARTDOCIGNORE_PATTERNS).toContain("**/CODEX.md");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/smartdocs-engine/smartdoc-ignore
```

Expected: 4 failures — patterns not yet in the array.

- [ ] **Step 3: Add the patterns to DEFAULT_SMARTDOCIGNORE_PATTERNS**

In `src/smartdocs-engine/smartdoc-ignore.ts`, add after the existing `GEMINI.md` / `**/GEMINI.md` entries:

```typescript
  "POLARIS_RULES.md",
  "**/POLARIS_RULES.md",
  "CODEX.md",
  "**/CODEX.md",
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/smartdocs-engine/smartdoc-ignore
```

Expected: all 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/smartdocs-engine/smartdoc-ignore.ts src/smartdocs-engine/smartdoc-ignore.test.ts
git commit -m "feat(smartdocs): add POLARIS_RULES.md and CODEX.md to default ignore list"
```

---

## Task 4: Create adopt-rules.ts — generatePolarisRules()

**Files:**
- Create: `src/cli/adopt-rules.ts`
- Create: `src/cli/adopt-rules.test.ts`

The `generatePolarisRules` function writes `POLARIS_RULES.md` to the repo root. It includes:
1. A compact repo overview (derived from the inventory's `architecture_notes` and `source_roots`)
2. The Temporary Worker Doctrine
3. The Repository Memory Doctrine
4. Skill command routing (tracker-agnostic)
5. Map-query-only rule
6. Tracker-agnostic work intake rule
7. Link to `.polaris/skills/ROUTING.md`

- [ ] **Step 1: Write the failing test**

Create `src/cli/adopt-rules.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { generatePolarisRules } from "./adopt-rules.js";
import type { RepoScanInventory } from "./adoption-plan.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedExistsSync = vi.mocked(fs.existsSync);

const baseInventory: RepoScanInventory = {
  scan_date: "2026-06-04T00:00:00.000Z",
  repo_state: "existing",
  package_manager: "npm",
  source_roots: ["src/"],
  docs_roots: ["docs/"],
  test_commands: ["npx vitest run"],
  build_commands: ["npm run build"],
  package_scripts: { test: "vitest run" },
  generated_roots: ["dist/"],
  cache_roots: [],
  fixture_roots: [],
  agent_instruction_files: [],
  existing_smartdocs_dirs: [],
  architecture_notes: ["TypeScript monorepo with CLI tooling"],
  likely_canonical_folders: ["src"],
  smartdocs_candidates: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedExistsSync.mockReturnValue(false);
});

describe("generatePolarisRules", () => {
  it("writes POLARIS_RULES.md to repo root", async () => {
    await generatePolarisRules("/repo", baseInventory);
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/repo/POLARIS_RULES.md",
      expect.any(String),
      "utf-8",
    );
  });

  it("includes Temporary Worker Doctrine", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("Temporary Worker Doctrine");
    expect(content).toContain("Roles persist");
  });

  it("includes Repository Memory Doctrine", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("Repository Memory Doctrine");
    expect(content).toContain("repository artifacts");
  });

  it("includes map-query-only rule", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("polaris map query");
    expect(content).toContain("file-routes.json");
  });

  it("includes CLUSTER-ID notation, not POL-###", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("CLUSTER-ID");
    expect(content).not.toMatch(/POL-###/);
  });

  it("includes link to ROUTING.md", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain(".polaris/skills/ROUTING.md");
  });

  it("skips write if POLARIS_RULES.md already exists and overwrite is false", async () => {
    mockedExistsSync.mockReturnValue(true);
    await generatePolarisRules("/repo", baseInventory, { overwrite: false });
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("overwrites if POLARIS_RULES.md exists and overwrite is true", async () => {
    mockedExistsSync.mockReturnValue(true);
    await generatePolarisRules("/repo", baseInventory, { overwrite: true });
    expect(mockedWriteFileSync).toHaveBeenCalled();
  });

  it("includes architecture notes from inventory in repo overview", async () => {
    await generatePolarisRules("/repo", baseInventory);
    const content = mockedWriteFileSync.mock.calls[0]?.[1] as string;
    expect(content).toContain("TypeScript monorepo with CLI tooling");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/cli/adopt-rules
```

Expected: module not found errors (file doesn't exist yet).

- [ ] **Step 3: Implement adopt-rules.ts**

Create `src/cli/adopt-rules.ts`:

```typescript
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RepoScanInventory } from "./adoption-plan.js";

export interface GeneratePolarisRulesOptions {
  overwrite?: boolean;
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

export async function generatePolarisRules(
  repoRoot: string,
  inventory: RepoScanInventory,
  options: GeneratePolarisRulesOptions = {},
): Promise<void> {
  const { overwrite = true } = options;
  const outputPath = join(repoRoot, "POLARIS_RULES.md");

  if (existsSync(outputPath) && !overwrite) {
    return;
  }

  const overview = buildRepoOverview(inventory);

  const content = [
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
    "## Tracker-Agnostic Work Intake",
    "",
    "Work identifiers are opaque to the model. Polaris is tracker-agnostic.",
    "",
    "Work may originate from Linear, GitHub, a SmartDocs spec, a local work contract,",
    "a manual prompt, or a future provider. The runtime resolves identifiers.",
    "The model does not interpret or construct issue identifiers.",
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

  const dir = dirname(outputPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, content, "utf-8");
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/cli/adopt-rules
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/adopt-rules.ts src/cli/adopt-rules.test.ts
git commit -m "feat(cli): add generatePolarisRules for POLARIS_RULES.md generation"
```

---

## Task 5: Update buildThinAdapter to pointer-only format

**Files:**
- Modify: `src/cli/adopt-instructions.ts`

The current `buildThinAdapter` emits a multi-line "delegate" comment block. It must be updated
to emit the 2-line pointer format. The `classifyInstruction` logic is simplified: when
`POLARIS_RULES.md` exists, all agent files become pointers. When it doesn't yet exist, preserve.

- [ ] **Step 1: Write the failing test**

Create `src/cli/adopt-instructions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { handleInstructionFiles } from "./adopt-instructions.js";
import type { AdoptionPlan } from "./adoption-plan.js";
import type { RepoScanInventory } from "./adoption-plan.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue("existing content"),
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

const basePlan: AdoptionPlan = {
  plan_id: "adoption-2026-06-04T00-00-00.000Z",
  generated_at: "2026-06-04T00:00:00.000Z",
  repo_state: "existing",
  approved: true,
  approved_at: "2026-06-04T00:00:00.000Z",
  dry_run: false,
  steps: [],
  impact_summary: {
    files_to_create: 0,
    files_to_move: 0,
    files_to_modify: 0,
    instruction_files_affected: 0,
    smartdocs_candidates_moved: 0,
    cognition_files_to_generate: 0,
  },
};

const baseInventory: RepoScanInventory = {
  scan_date: "2026-06-04T00:00:00.000Z",
  repo_state: "existing",
  package_manager: "npm",
  source_roots: ["src/"],
  docs_roots: [],
  test_commands: [],
  build_commands: [],
  package_scripts: {},
  generated_roots: [],
  cache_roots: [],
  fixture_roots: [],
  agent_instruction_files: [
    {
      path: "AGENTS.md",
      provider: "openai",
      size_bytes: 1200,
      has_polaris_delegation: false,
      recommendation: "migrate",
      reason: "repo-specific",
    },
  ],
  existing_smartdocs_dirs: [],
  architecture_notes: [],
  likely_canonical_folders: [],
  smartdocs_candidates: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleInstructionFiles — pointer format", () => {
  it("writes pointer-only content when POLARIS_RULES.md exists", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("POLARIS_RULES.md") || s.endsWith("AGENTS.md");
    });

    await handleInstructionFiles(basePlan, baseInventory);

    const call = mockedWriteFileSync.mock.calls.find(
      ([p]) => String(p).endsWith("AGENTS.md"),
    );
    expect(call).toBeDefined();
    const content = call![1] as string;
    expect(content).toContain("# Polaris Managed Repository");
    expect(content).toContain("POLARIS_RULES.md");
    expect(content).not.toContain("polaris:delegate");
  });

  it("preserves original file when POLARIS_RULES.md does not exist", async () => {
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("AGENTS.md") && !s.endsWith("POLARIS_RULES.md");
    });

    await handleInstructionFiles(basePlan, baseInventory);

    const call = mockedWriteFileSync.mock.calls.find(
      ([p]) => String(p).endsWith("AGENTS.md"),
    );
    // should not overwrite if POLARIS_RULES.md doesn't exist
    expect(call).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/cli/adopt-instructions
```

Expected: failures — pointer format not yet emitted.

- [ ] **Step 3: Update buildThinAdapter in adopt-instructions.ts**

Replace the existing `buildThinAdapter` function:

```typescript
function buildThinAdapter(_sourcePath: string): string {
  return [
    "# Polaris Managed Repository",
    "",
    "Read [POLARIS_RULES.md](POLARIS_RULES.md) before doing any work in this repository.",
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Update classifyInstruction to use pointer when POLARIS_RULES.md exists**

Replace the existing `classifyInstruction` function:

```typescript
function classifyInstruction(
  content: string,
  doctrineExists: boolean,
  repoHints: string[],
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
```

Update `hasDoctrine` to check for `POLARIS_RULES.md` in addition to existing checks:

```typescript
function hasDoctrine(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, "POLARIS_RULES.md")) ||
    existsSync(join(repoRoot, "POLARIS.md")) ||
    existsSync(join(repoRoot, "smartdocs", "doctrine", "active"))
  );
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npx vitest run src/cli/adopt-instructions
```

Expected: all new tests pass.

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
npx vitest run
```

Expected: all 92 test files pass (1338+ tests).

- [ ] **Step 7: Commit**

```bash
git add src/cli/adopt-instructions.ts src/cli/adopt-instructions.test.ts
git commit -m "feat(cli): update adopt-instructions to emit pointer-only agent files"
```

---

## Task 6: Wire generatePolarisRules into polaris init --adopt

**Files:**
- Modify: `src/cli/init.ts`

`generatePolarisRules` must be called before `handleInstructionFiles` in the adopt flow, so
that `POLARIS_RULES.md` exists when agent files are converted to pointers.

- [ ] **Step 1: Add the import to init.ts**

At the top of `src/cli/init.ts`, add alongside the other adopt-* imports:

```typescript
import { generatePolarisRules } from "./adopt-rules.js";
```

- [ ] **Step 2: Write the failing test**

In `src/cli/init.test.ts`, find the adopt flow tests and add:

```typescript
it("calls generatePolarisRules before handleInstructionFiles during adopt", async () => {
  // The test verifies call order — generatePolarisRules must be called first.
  const callOrder: string[] = [];

  const mockGeneratePolarisRules = vi.fn().mockImplementation(async () => {
    callOrder.push("generatePolarisRules");
  });
  const mockHandleInstructionFiles = vi.fn().mockImplementation(async () => {
    callOrder.push("handleInstructionFiles");
  });

  // ... wire these into the init flow via injected options
  // (follow the existing injection pattern used for scanAdoptionInventory, etc.)

  expect(callOrder.indexOf("generatePolarisRules")).toBeLessThan(
    callOrder.indexOf("handleInstructionFiles"),
  );
});
```

Note: Follow the existing injection pattern in `InitOptions` — look at how `scanAdoptionInventory`
and `generateFolderCognition` are injected as optional overrides for testing.

- [ ] **Step 3: Add injection interface to InitOptions**

In `src/cli/init.ts`, add to the `InitOptions` interface:

```typescript
/** Injected POLARIS_RULES.md generator — for unit testing. */
generatePolarisRulesContent?: (
  repoRoot: string,
  inventory: RepoScanInventory,
  options?: { overwrite?: boolean },
) => Promise<void>;
```

- [ ] **Step 4: Wire the call into the adopt flow**

Locate the section in `runInit` (or its helper) that calls `handleInstructionFiles`. Add the
`generatePolarisRules` call immediately before it:

```typescript
const generateRules = options.generatePolarisRulesContent ?? generatePolarisRules;
await generateRules(repoRoot, inventory, { overwrite: false });
// then existing handleInstructionFiles call follows
```

The `overwrite: false` default means re-running `polaris init --adopt` won't clobber a
user-customized `POLARIS_RULES.md`.

- [ ] **Step 5: Run the init tests**

```bash
npx vitest run src/cli/init
```

Expected: all existing init tests pass, new test passes.

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/init.ts
git commit -m "feat(cli): wire generatePolarisRules into polaris init --adopt flow"
```

---

## Task 7: Build and update this repo's own AGENTS.md, CLAUDE.md, POLARIS_RULES.md

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Create: `POLARIS_RULES.md`

This repo is itself a Polaris-managed repo and should adopt the architecture it defines.
The existing `AGENTS.md` and `CLAUDE.md` content is substantive — it moves to `POLARIS_RULES.md`.

- [ ] **Step 1: Build the project**

```bash
npm run build
```

Expected: `dist/cli/index.js` produced with no TypeScript errors.

- [ ] **Step 2: Create POLARIS_RULES.md for this repo**

Write `POLARIS_RULES.md` at repo root with content derived from the current `AGENTS.md` and
`CLAUDE.md`. The file must contain all sections defined in the spec:

```markdown
# Polaris Rules

> This file is the single shared governance source for this Polaris-managed repository.
> Agent files (AGENTS.md, CLAUDE.md, etc.) are pointers to this file.
> This file is SmartDocs-ignored — it is bootstrap governance, not doctrine.

## Repository Overview

Polaris is a governed multi-agent execution runtime for software development. It manages
work through routed issue clusters, Smart Docs, and bounded worker sessions. The CLI is a
TypeScript/Node.js package at `src/`. Skills live in `.polaris/skills/`.

---

## Temporary Worker Doctrine

Every model instance is a temporary occupant of a durable role. Roles persist; model
instances are disposable.

A worker should arrive at a task knowing only:
- what job it is doing
- what files it may touch
- what route governs the work
- what validation proves completion

If a worker requires broad repository context, the cognition structure has failed — not
the worker.

---

## Repository Memory Doctrine

Polaris stores institutional memory in repository artifacts rather than model memory.
Knowledge should be discoverable through navigation, route cognition, SmartDocs,
summaries, commits, telemetry, and runtime artifacts.

Workers should not rely on persistent model memory to perform assigned work.

---

## Skill Command Routing

**This rule takes priority over all other instructions when the user issues an explicit
Polaris skill command.**

When a Polaris skill command is received, load the skill packet before any other action.
Full routing table: `.polaris/skills/ROUTING.md`

Recognized command forms:

- `polaris-analyze <CLUSTER-ID>` / `run polaris-analyze on [issue] <CLUSTER-ID>`
- `polaris-run <CLUSTER-ID>` / `run polaris-run on [issue] <CLUSTER-ID>`
- `polaris-finalize` / `run polaris-finalize`
- `polaris-status` / `run polaris-status`
- `docs-ingest` / `run docs-ingest`
- `polaris-reconcile <CLUSTER-ID>` / `run polaris-reconcile on [issue] <CLUSTER-ID>`
- `polaris-catalog <CLUSTER-ID>` / `run polaris-catalog on [issue] <CLUSTER-ID>`

When a recognized command is received:
1. Look up the target skill in `.polaris/skills/ROUTING.md`, then read
   `.polaris/skills/<target-skill>/SKILL.md` **first** — before any repo inspection,
   issue summarization, or runtime file reads.
2. Run the bootloader command in that SKILL.md to obtain the runtime packet.
3. Execute the skill's `chain.md` in strict step order.
4. If the command names a cluster (e.g., `POL-257`), bind exactly that cluster.
5. If the skill packet is missing, stop and report:
   `Blocking: skill packet not found at .polaris/skills/<target-skill>/SKILL.md`

---

## Map-Query Rule

The map is runtime infrastructure. Query results are model context.

**Agents may query the map. Agents may not consume map artifacts.**

Use:
```
polaris map query <path>
```

Never read these files directly:
- `.polaris/map/file-routes.json`
- `.polaris/map/index.json`
- `.polaris/map/needs-review.json`

These paths appear only in prohibition lists.

---

## Tracker-Agnostic Work Intake

Work identifiers are opaque to the model. Polaris is tracker-agnostic.

The core runtime must not assume Linear or any specific tracker:
- Tracker-specific logic belongs exclusively in adapter implementations
  (`src/tracker/adapters/<name>/`).
- `WorkerPacket`, `BootstrapPacket`, and all loop/dispatch subsystems operate on
  `LocalGraph` — never on tracker-specific types.
- Hardcoded references to "Linear" in instruction text, packet compilation, or skill
  generation are defects.
- `runFinalize()` must skip cleanly when no tracker adapter is configured.

---

## Runtime Behavior

- Resolve execution state before beginning work.
- Follow the active cluster and child ordering.
- Execute only the currently assigned child.
- Do not expand scope outside the assigned child.
- If blocked, stop and report the unblock condition.
- Foreman orchestrates; Worker implements; Librarian reconciles.
- A provider may occupy multiple roles, but role authority does not merge.

---

## Canon Discovery

Project canon is route-local.

Use:
- `POLARIS.md` in the relevant route folder for operational guidance
- `SUMMARY.md` in the relevant route folder for informational context
- `polaris map query <path>` for route and ownership resolution
- Runtime state artifacts for execution state and resume handling

Do not assume global repository context unless explicitly provided by the runtime.
```

- [ ] **Step 3: Replace AGENTS.md with pointer**

Write `AGENTS.md`:

```markdown
# Polaris Managed Repository

Read [POLARIS_RULES.md](POLARIS_RULES.md) before doing any work in this repository.
```

- [ ] **Step 4: Replace CLAUDE.md with pointer**

Write `CLAUDE.md`:

```markdown
# Polaris Managed Repository

Read [POLARIS_RULES.md](POLARIS_RULES.md) before doing any work in this repository.
```

- [ ] **Step 5: Verify the build still passes**

```bash
npm run build && npx vitest run
```

Expected: clean build, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add POLARIS_RULES.md AGENTS.md CLAUDE.md
git commit -m "feat(repo): adopt POLARIS_RULES.md architecture — pointer-only agent files"
```

---

## Task 8: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: all test files pass.

- [ ] **Step 2: Verify no npm run polaris references remain in skill files**

```bash
grep -r "npm run polaris" .polaris/skills/
```

Expected: no output.

- [ ] **Step 3: Verify no file-routes.json references remain in agent-facing docs**

```bash
grep -r "file-routes.json" AGENTS.md CLAUDE.md POLARIS_RULES.md .polaris/skills/
```

Expected: no output (or only in prohibition list contexts).

- [ ] **Step 4: Verify POLARIS_RULES.md is not empty and contains all required sections**

```bash
grep -c "Temporary Worker Doctrine\|Repository Memory Doctrine\|Map-Query Rule\|Tracker-Agnostic\|Skill Command Routing" POLARIS_RULES.md
```

Expected: `5`

- [ ] **Step 5: Verify pointer format in AGENTS.md and CLAUDE.md**

```bash
cat AGENTS.md && echo "---" && cat CLAUDE.md
```

Expected: both files contain only the 3-line pointer format.

- [ ] **Step 6: Commit if anything was missed**

```bash
git status
```

If clean: no action needed. If there are uncommitted changes from the verification sweep,
stage and commit them with a descriptive message.
