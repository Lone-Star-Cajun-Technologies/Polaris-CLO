---
source: smartdocs/raw/2026-05-25-claude-plugin-runtime-integration.md
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-06-04-015
classified-as: architecture
linked-map-area: src/cli
ingested-at: 2026-06-04T06:35:17.283Z
status: raw
---

# Claude Plugin Runtime Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Polaris CLI stubs to real implementations and prove Claude Code can invoke `polaris status` through the `.claude/skills/` plugin surface.

**Architecture:** The `.claude/skills/` directory already IS the Claude Code plugin — two skills exist (`polaris-run.md`, `polaris-loop.md`). The stubs in `src/cli/index.ts` call `console.log("[polaris] ... not yet implemented")` instead of calling the real implementations that already exist in `src/loop/`. This plan wires those together, adds a dedicated `polaris-status.md` skill, fixes `npm test` to run vitest, and documents the smoke-test path.

**Tech Stack:** TypeScript 5 / Node16, vitest, Node.js `spawnSync` / `child_process`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/cli/args.ts` | Create | Parse `--flag value` and `--flag` from `process.argv` |
| `src/cli/args.test.ts` | Create | Unit tests for the arg parser |
| `src/cli/index.ts` | Modify | Wire `status`, `loop status`, `loop continue` to real implementations |
| `package.json` | Modify | Change `test` script from `echo` stub to `vitest run` |
| `.claude/skills/polaris-status.md` | Create | Claude skill: invoke `polaris status` |
| `docs/integrations/claude-plugin.md` | Create | Document plugin surface, install path, smoke test |

---

## Task 1: Fix `npm test` to run the existing vitest suite

`package.json` has `"test": "echo 'no tests yet' && exit 0"` but vitest is installed and test files exist. This silently hides failures.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the test script**

Open `package.json`. Change the `scripts.test` line from:
```json
"test": "echo 'no tests yet' && exit 0"
```
to:
```json
"test": "vitest run"
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
cd /Users/lsctech/Developer/Polaris
npm test
```

Expected: 218 passing, 8 known failures (baseline) — investigate any changes beyond this baseline.

- [ ] **Step 3: Commit**

```bash
cd /Users/lsctech/Developer/Polaris
git add package.json
git commit -m "fix: run vitest in npm test instead of no-op stub"
```

---

## Task 2: Create `src/cli/args.ts` — simple flag parser

The CLI needs to parse `--state-file <path>`, `--json`, `--dry-run` without pulling in a third-party library.

**Files:**
- Create: `src/cli/args.ts`
- Create: `src/cli/args.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/args.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("parses --state-file value", () => {
    const r = parseCliArgs(["--state-file", "path/to/state.json"]);
    expect(r.flags["state-file"]).toBe("path/to/state.json");
    expect(r.positional).toEqual([]);
  });

  it("parses boolean flag", () => {
    const r = parseCliArgs(["--json"]);
    expect(r.flags["json"]).toBe(true);
    expect(r.positional).toEqual([]);
  });

  it("parses --dry-run", () => {
    const r = parseCliArgs(["--dry-run"]);
    expect(r.flags["dry-run"]).toBe(true);
  });

  it("collects positional args before flags", () => {
    const r = parseCliArgs(["continue", "--json"]);
    expect(r.positional).toEqual(["continue"]);
    expect(r.flags["json"]).toBe(true);
  });

  it("returns empty flags and positional for empty input", () => {
    const r = parseCliArgs([]);
    expect(r.flags).toEqual({});
    expect(r.positional).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd /Users/lsctech/Developer/Polaris
npx vitest run src/cli/args.test.ts
```

Expected: FAIL — `Cannot find module './args.js'`

- [ ] **Step 3: Implement `src/cli/args.ts`**

Create `src/cli/args.ts`:

```typescript
export interface CliArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return { flags, positional };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/lsctech/Developer/Polaris
npx vitest run src/cli/args.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/lsctech/Developer/Polaris
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "feat: add CLI arg parser for --state-file, --json, --dry-run flags"
```

---

## Task 3: Wire `polaris status` and `polaris loop status` to `runLoopStatus`

`src/loop/status.ts` exports `runLoopStatus(options: StatusOptions)` with a real implementation that reads `current-state.json`. The CLI stub in `src/cli/index.ts` ignores it. This task wires them together and adds state file auto-discovery.

The state file lives at `.taskchain_artifacts/polaris-run/current-state.json` in practice, but `runLoopStatus` defaults to `.polaris/runs/current-state.json`. Discovery should try both.

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Read the current import section of `src/cli/index.ts`**

The file currently has no imports. Verify it still matches what's shown above (no imports, raw switch/case stubs).

- [ ] **Step 2: Rewrite `src/cli/index.ts`**

Replace the entire file with:

```typescript
#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCliArgs } from "./args.js";
import { runLoopStatus } from "../loop/status.js";
import { runLoopContinue } from "../loop/continue.js";

const repoRoot = resolve(process.cwd());
const [, , cmd, ...rest] = process.argv;
const { flags, positional } = parseCliArgs(rest);

function findStateFile(): string {
  const taskchainPath = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
  const polarisPath = join(repoRoot, ".polaris", "runs", "current-state.json");
  if (flags["state-file"] && typeof flags["state-file"] === "string") {
    return resolve(flags["state-file"]);
  }
  if (existsSync(taskchainPath)) return taskchainPath;
  if (existsSync(polarisPath)) return polarisPath;
  return taskchainPath; // let runLoopStatus report the missing-file error
}

function usage(): void {
  console.log("Usage: polaris <command> [subcommand] [options]");
  console.log("");
  console.log("Commands:");
  console.log("  status                       Print current loop state");
  console.log("  loop status                  Print current loop state");
  console.log("  loop continue                Advance the current taskchain loop");
  console.log("  run                          Start or resume a Polaris run");
  console.log("");
  console.log("Options:");
  console.log("  --state-file <path>          Path to current-state.json");
  console.log("  --json                       Output as JSON");
  console.log("  --dry-run                    Dry-run mode (no mutations)");
  process.exit(1);
}

switch (cmd) {
  case "run":
    console.log("[polaris] run — not yet implemented (Cluster 4)");
    break;

  case "loop": {
    const sub = positional[0] ?? rest[0];
    if (sub === "continue") {
      runLoopContinue({
        stateFile: findStateFile(),
        repoRoot,
        dryRun: flags["dry-run"] === true,
      });
    } else if (sub === "status") {
      runLoopStatus({
        stateFile: findStateFile(),
        repoRoot,
        json: flags["json"] === true,
      });
    } else {
      console.error(`Unknown loop subcommand: ${sub ?? "(none)"}`);
      usage();
    }
    break;
  }

  case "status":
    runLoopStatus({
      stateFile: findStateFile(),
      repoRoot,
      json: flags["json"] === true,
    });
    break;

  default:
    if (!cmd) {
      usage();
    } else {
      console.error(`Unknown command: ${cmd}`);
      usage();
    }
}
```

- [ ] **Step 3: Check that `runLoopContinue` accepts `dryRun`**

```bash
cd /Users/lsctech/Developer/Polaris
grep -n "dryRun\|dry_run\|ContinueOptions" src/loop/continue.ts | head -20
```

If `ContinueOptions` does not have a `dryRun` field, remove `dryRun: flags["dry-run"] === true` from the `runLoopContinue` call in `src/cli/index.ts` and leave just `{ stateFile: findStateFile(), repoRoot }`. Do not add `dryRun` to `ContinueOptions` — only wire what already exists.

- [ ] **Step 4: Build**

```bash
cd /Users/lsctech/Developer/Polaris
npm run build
```

Expected: Exits 0, `dist/cli/index.js` updated.

- [ ] **Step 5: Smoke test — status with real state**

```bash
cd /Users/lsctech/Developer/Polaris
node dist/cli/index.js status
```

Expected: Prints the loop status table (Run ID, Cluster, Branch, etc.) from `.taskchain_artifacts/polaris-run/current-state.json`.

- [ ] **Step 6: Smoke test — JSON output**

```bash
cd /Users/lsctech/Developer/Polaris
node dist/cli/index.js status --json
```

Expected: Prints valid JSON with `run_id`, `cluster_id`, `status`, etc.

- [ ] **Step 7: Run full test suite**

```bash
cd /Users/lsctech/Developer/Polaris
npm test
```

Expected: 218 passing, 8 known failures (baseline) — investigate any changes beyond this baseline.

- [ ] **Step 8: Lint**

```bash
cd /Users/lsctech/Developer/Polaris
npm run lint
```

Expected: No TypeScript errors.

- [ ] **Step 9: Commit**

```bash
cd /Users/lsctech/Developer/Polaris
git add src/cli/index.ts
git commit -m "feat: wire polaris status and loop status to real runLoopStatus implementation"
```

---

## Task 4: Verify `npm link` invocation path

This proves that `polaris status` works as a globally-linked binary — the same path used by the `.claude/skills/` plugin.

**Files:** None created; this is a verification task.

- [ ] **Step 1: Check shebang in compiled output**

```bash
head -1 /Users/lsctech/Developer/Polaris/dist/cli/index.js
```

Expected: `#!/usr/bin/env node`

If not present, the shebang from `src/cli/index.ts` was not preserved. In that case, add a `postbuild` script to `package.json`:
```json
"postbuild": "echo '#!/usr/bin/env node' | cat - dist/cli/index.js > /tmp/polaris-cli.js && mv /tmp/polaris-cli.js dist/cli/index.js && chmod +x dist/cli/index.js"
```
Then re-run `npm run build`.

- [ ] **Step 2: Ensure the output is executable**

```bash
chmod +x /Users/lsctech/Developer/Polaris/dist/cli/index.js
ls -la /Users/lsctech/Developer/Polaris/dist/cli/index.js
```

Expected: File has execute bit set (`-rwxr-xr-x`).

- [ ] **Step 3: Run `npm link`**

```bash
cd /Users/lsctech/Developer/Polaris
npm link
```

Expected: Exits 0. Creates a global symlink for `polaris`.

- [ ] **Step 4: Verify `polaris` is on PATH**

```bash
which polaris
```

Expected: Prints a path (e.g. `/usr/local/bin/polaris` or the npm global bin path).

- [ ] **Step 5: Run `polaris status` as the linked binary**

```bash
polaris status
```

Expected: Prints the loop status table. Same output as `node dist/cli/index.js status`.

- [ ] **Step 6: Run `polaris status --json`**

```bash
polaris status --json
```

Expected: Valid JSON.

- [ ] **Step 7: Commit the executable bit if needed**

If you had to add a `postbuild` script in Step 1, commit `package.json`:
```bash
cd /Users/lsctech/Developer/Polaris
git add package.json
git commit -m "fix: ensure dist/cli/index.js has executable bit via postbuild"
```

If no changes were needed, skip this step.

---

## Task 5: Add `polaris-status.md` Claude Code skill

The existing `.claude/skills/` already exposes `polaris-run` and `polaris-loop`. Add a dedicated `polaris-status` skill that is the proof command — safe, read-only, no side effects.

**Files:**
- Create: `.claude/skills/polaris-status.md`

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/polaris-status.md`:

```markdown
# polaris-status

Print the current Polaris runtime status for the active taskchain run.

## Steps

1. Determine the Polaris binary to use:
   - If `$POLARIS_BIN` is set, use that value as the command prefix.
   - Otherwise, use `polaris`.

2. Run the command:
   ```
   polaris status
   ```
   or, if `$POLARIS_BIN` is set:
   ```
   $POLARIS_BIN status
   ```

3. If the command exits non-zero, report the full error output and stop.
   Common causes:
   - `dist/cli/index.js` is missing: run `npm run build` in the Polaris repo.
   - `polaris` binary not found: run `npm link` from the Polaris repo root.
   - No `current-state.json` found: no active run in this repo.

4. If the command succeeds, display the output to the user.

## JSON mode

To get machine-readable output:
```
polaris status --json
```

## Targeting a specific state file

```
polaris status --state-file .taskchain_artifacts/polaris-run/current-state.json
```

## Preconditions

- The Polaris CLI must be built: `npm run build` in the Polaris repo.
- The binary must be reachable. See `.claude/README.md` for setup options.
- At least one Polaris run must have been started (state file must exist).

## Notes

- This command is read-only. Safe to run at any time.
- It reports the in-memory state from `current-state.json` — not live execution state.
- Use `polaris loop status` for an equivalent command via the loop skill.
```

- [ ] **Step 2: Verify the skill file is reachable**

```bash
ls /Users/lsctech/Developer/Polaris/.claude/skills/
```

Expected: `polaris-loop.md  polaris-run.md  polaris-status.md`

- [ ] **Step 3: Commit**

```bash
cd /Users/lsctech/Developer/Polaris
git add .claude/skills/polaris-status.md
git commit -m "feat: add polaris-status Claude Code skill"
```

---

## Task 6: Create `docs/integrations/claude-plugin.md`

Document what the Claude plugin is, how it is installed/loaded, what it exposes, how it invokes the runtime, and how to run the smoke test. This satisfies the spec's requirement to document the installation path and prove invocation.

**Files:**
- Create: `docs/integrations/claude-plugin.md`

- [ ] **Step 1: Create the documentation file**

Create `docs/integrations/claude-plugin.md`:

````markdown
# Claude Plugin for Polaris

## What It Is

The Polaris Claude plugin is the `.claude/` directory in this repository.
Claude Code automatically loads skills from `.claude/skills/` when opened in
this repo — no separate installation step is needed.

This is the Claude Code plugin surface. Claude Desktop has a different plugin
model (MCP-based) not covered here. See Open Questions below.

## Skills Exposed

| Skill file | Slash command | What it invokes |
|---|---|---|
| `skills/polaris-status.md` | `/polaris-status` | `polaris status` |
| `skills/polaris-run.md` | `/polaris-run` | `polaris run` |
| `skills/polaris-loop.md` | `/polaris-loop` | `polaris loop continue` or `polaris loop status` |

## Installation

### Option A — npm link (recommended for local development)

```bash
cd /path/to/Polaris
npm install
npm run build
npm link
```

Verify:
```bash
polaris status
```

Expected output: Loop status table printed from `.taskchain_artifacts/polaris-run/current-state.json`.

### Option B — repo-local (no global install)

```bash
node /path/to/Polaris/dist/cli/index.js status
```

To use with the skills, set `POLARIS_BIN`:
```bash
export POLARIS_BIN="node /path/to/Polaris/dist/cli/index.js"
```

## How Invocation Works

```
Claude Code (user types /polaris-status)
  → Claude reads .claude/skills/polaris-status.md
  → Skill instructions tell Claude to call the polaris binary
  → Claude uses its Bash tool to run: polaris status
  → Output is returned to the user
```

No MCP server is required for Claude Code. The skills are markdown instruction
files. Claude executes shell commands using its built-in Bash tool.

## Smoke Test

After `npm link`:

```bash
# Safe read-only check — proves the full invocation path
polaris status

# JSON output — for programmatic verification
polaris status --json

# Dry-run — proves the run path without mutating state
node dist/cli/index.js loop continue --dry-run --state-file .taskchain_artifacts/polaris-run/current-state.json
```

All three must exit 0.

## Runtime Architecture Compliance

The plugin is thin by design:

- Skills expose commands and call `polaris` binary.
- The binary delegates to `src/loop/` and `src/finalize/` — Polaris owns the loop.
- Skills do not parse or mutate `current-state.json` directly.
- Chat context is not treated as execution memory.

## Open Questions / Blockers

1. **Claude Desktop**: The `.claude/skills/` mechanism is Claude Code only.
   Claude Desktop uses a different plugin model. If Polaris needs a Claude
   Desktop integration, an MCP server wrapper is likely required. This is a
   follow-up item.

2. **`polaris run` is stubbed**: `polaris run` prints `[polaris] run — not yet
   implemented (Cluster 4)`. Full run execution is a Cluster 4 deliverable.

3. **`polaris loop continue` calls `runLoopContinue`**: This is wired but the
   implementation spawns a real Claude agent session. Do not invoke in dry-run
   without verifying adapter behavior first.

4. **Provider neutrality**: The plugin routes to Polaris runtime. Polaris
   manages provider selection. The plugin does not hardcode Claude.
````

- [ ] **Step 2: Commit**

```bash
cd /Users/lsctech/Developer/Polaris
git add docs/integrations/claude-plugin.md
git commit -m "docs: add Claude plugin integration documentation with smoke test"
```

---

## Task 7: Full validation pass

Run the complete validation suite as defined in the spec.

**Files:** None created.

- [ ] **Step 1: Build**

```bash
cd /Users/lsctech/Developer/Polaris
npm run build
```

Expected: Exit 0.

- [ ] **Step 2: Lint**

```bash
cd /Users/lsctech/Developer/Polaris
npm run lint
```

Expected: No TypeScript errors.

- [ ] **Step 3: Test suite**

```bash
cd /Users/lsctech/Developer/Polaris
npm test
```

Expected: 218 passing, 8 known failures (baseline) — investigate any changes beyond this baseline.

- [ ] **Step 4: Smoke test — status**

```bash
polaris status
```

Expected: Prints loop status table. Exits 0.

- [ ] **Step 5: Smoke test — JSON**

```bash
polaris status --json | python3 -c "import sys,json; d=json.load(sys.stdin); print('run_id:', d['run_id'])"
```

Expected: Prints `run_id: <run-id-value>`. Exits 0.

- [ ] **Step 6: Verify skill files exist**

```bash
ls /Users/lsctech/Developer/Polaris/.claude/skills/
```

Expected: `polaris-loop.md  polaris-run.md  polaris-status.md`

- [ ] **Step 7: Verify binary is linked**

```bash
which polaris && polaris status > /dev/null && echo "invocation path: OK"
```

Expected: `invocation path: OK`

- [ ] **Step 8: Confirm no Claude-only lock-in**

```bash
grep -r "claude\|Claude" /Users/lsctech/Developer/Polaris/src/ --include="*.ts" | grep -v "test\|spec\|comment" | grep -i "provider\|only\|hardcode" || echo "no provider lock-in found"
```

Expected: `no provider lock-in found` or only documentation references.

---

## Self-Review

**Spec coverage:**

| Spec Requirement | Task |
|---|---|
| `polaris status` skill + invocation | Task 3 (CLI wire) + Task 5 (skill) |
| `polaris run` (stub, dry-run only) | Existing stub preserved; documented as open |
| `polaris loop continue` | Task 3 (CLI wire) |
| Dry-run / smoke test | Task 4 (npm link) + Task 7 (validation) |
| CLI packaging (`npm link`) | Task 4 |
| Plugin manifest path | Task 6 (documented: `.claude/skills/`) |
| Claude Desktop vs Claude Code difference | Task 6 (documented as open) |
| MCP requirement | Task 6 (documented: not needed for Claude Code) |
| State file discovery | Task 3 (`findStateFile()` helper) |
| Compact runtime output | `polaris status --json` returns compact JSON |
| Safety (read-only status) | `runLoopStatus` is read-only; no writes |
| Existing tests pass | Task 1 (fix npm test) + Task 7 |
| No provider lock-in | Task 7 Step 8 |
| Plugin documentation | Task 6 |

**Blockers documented in Task 6:** Claude Desktop MCP gap, `polaris run` stub, `loop continue` live adapter behavior.
