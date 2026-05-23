> Source: git-fit/docs/evonotes/planning-specs/ — canonical Polaris architecture reference

# Polaris Architecture Specification

**Status:** Draft
**Parent:** POL-1
**Inputs:** `docs/raw/ralph-architecture-analysis.md`, `docs/raw/ralph-evo-comparison.md`, `.evo/routing.md`, `.evo/run-state/current-state-schema.md`

This document specifies the Polaris runtime layer architecture. Polaris is a shared orchestration and mapping layer for EVO taskchains and other spec-driven execution workflows. It is not a replacement for EVO; it is the runtime infrastructure that EVO skills consume.

---

## 1. `polaris loop`

### Purpose

`polaris loop` is the checkpoint/resume command for bounded taskchain execution. It replaces EVO's current soft-rule session boundaries (chain step 07 budget thresholds) with a structural operation that:

1. Writes a complete run state snapshot
2. Appends a JSONL audit event
3. Runs changed-file map validation
4. Generates a compact bootstrap packet for the next session
5. Signals or terminates the current context window

This enforces the core principle from Ralph analysis: **the durable object is STATE, not SESSION**. Session boundaries are structural, not instructional.

### Sub-commands

| Command | What it does |
|---|---|
| `polaris loop continue` | Checkpoint current session, generate next-session bootstrap packet, signal session end |
| `polaris loop status` | Print current run_id, active child, step cursor, budget, and next open child |
| `polaris loop resume [run_id]` | Read current-state.json (or specified run_id from archive), emit bootstrap packet, ready for agent pickup |
| `polaris loop abort [reason]` | Record blocker, set status to blocked, halt cleanly |

### Checkpoint sequence (what `polaris loop continue` does)

```
1. Write current-state.json with updated step cursor, completed child, context budget
2. Append JSONL event: {"event": "loop-checkpoint", "run_id": ..., "child_id": ..., "next_child": ..., ...}
3. Run polaris map update --changed (validate changed files have sidecar entries)
4. Generate compact bootstrap packet (see Bootstrap Packet Format below)
5. Emit bootstrap packet to stdout or write to .polaris/bootstrap/[run_id]-[timestamp].json
6. Signal session end (exit 0 or emit end-of-session marker for agent harness)
```

### Bootstrap packet format

The bootstrap packet is the ONLY input a resumed session should receive from Polaris state. It is a deliberate, minimal context slice:

```json
{
  "run_id": "run-2026-05-22-001",
  "skill": "evo-run",
  "branch": "evo/POL-2-bootstrap-repo-structure",
  "last_completed_step": "06-commit-and-update-linear",
  "last_completed_child": "POL-10",
  "next_step": "03-select-child",
  "open_children": [
    {"id": "POL-11", "title": "[C1.3] Copy planning docs and architecture specs", "deps_satisfied": true},
    {"id": "POL-12", "title": "[C1.4] Create temporary bootstrap taskchain skill", "deps_satisfied": false}
  ],
  "artifact_pointers": {
    "current_state": ".taskchain_artifacts/bootstrap-run/current-state.json",
    "telemetry": ".taskchain_artifacts/bootstrap-run/runs/run-2026-05-22-001.jsonl"
  },
  "context_budget": {
    "children_completed": 2,
    "files_touched_total": 19,
    "stop_threshold_remaining": 2
  },
  "resume_instructions": "Resume evo-run on POL-2. Next step: 03-select-child. Branch: evo/POL-2-bootstrap-repo-structure."
}
```

**What is NOT in the bootstrap packet:**
- Prior conversation history
- Full current-state.json (pointers only)
- Validation logs
- Doctrine docs
- Skill chain body
- Commit messages

### Analyze→implementation boundary rule

Analyze children must NOT auto-continue into implementation children in the same session.

When `polaris loop continue` detects that the current session is an analyze-type run (or the last completed child was an analyze step):
1. The next child's type is checked against the session type
2. If the next child is an implementation child and the session was opened as analyze: **hard stop**
3. Emit: `{"event": "analyze-impl-boundary-enforced", "run_id": ..., "stopped_before": "POL-XXX", ...}`
4. Bootstrap packet includes: `"boundary_enforcement": "analyze-session-ended; implementation requires fresh session with explicit impl scope"`
5. Human or operator must start a new session with explicit implementation scope

**Why structural:** Current EVO relies on the evo-analyze skill being separate from evo-run. But a single agent session can read evo-analyze chain.md and then continue by reading evo-run chain.md. Polaris loop enforces the boundary by inspecting session type, not by trusting skill separation.

---

## 2. `polaris map`

### Purpose

`polaris map` creates and maintains a sidecar repo atlas. The atlas maps files to route/domain/taskchain ownership, enabling agents to navigate the repo through structured metadata rather than repeated broad traversal.

**Design principle — sidecar-first:** The atlas lives in sidecar files (`.polaris/map/`), not inline in application files. Runtime files, generated files, config files, assets, lockfiles, and sensitive files are never mutated for routing metadata.

### Sub-commands

| Command | What it does |
|---|---|
| `polaris map index` | Full first-pass atlas generation for an existing repo |
| `polaris map backfill` | Find files missing sidecar metadata in an already-indexed repo and generate entries |
| `polaris map update --changed` | For each file changed in the current session, check/add/validate sidecar entry |
| `polaris map validate` | Check all indexed files for valid route nodes; report unmapped, stale, or conflicted entries |
| `polaris map query [path]` | Print sidecar metadata for a specific file or path glob |

### Sidecar atlas structure

```
.polaris/
  map/
    file-routes.json      # Primary file → route mapping (keyed by relative path)
    exemptions.json       # Files explicitly classified as tracked-not-indexed or ignored
    index.json            # Compiled atlas: all entries with confidence + metadata
  bootstrap/              # Per-session bootstrap packets (checkpoint outputs)
  runs/                   # Archived run snapshots (per polaris finalize)
```

### `file-routes.json` entry format

```json
{
  "src/cli/index.ts": {
    "domain": "cli",
    "route": "src/cli",
    "taskchain": "polaris-cli",
    "confidence": 0.95,
    "classification": "indexed",
    "last_updated": "2026-05-22T20:00:00Z",
    "updated_by": "polaris-map-update",
    "tags": ["cli", "entry-point", "typescript"]
  }
}
```

### Changed-file validation flow (`polaris map update --changed`)

Runs automatically inside `polaris loop continue` and `polaris finalize`. For each changed durable file in the current session:

```
1. Check file-routes.json for existing sidecar entry
2. If entry exists: validate route node is still valid → update last_updated
3. If no entry exists:
   a. Check exemptions.json — if classified as tracked-not-indexed or ignored: skip
   b. Run route inference (see inference rules below)
   c. If confidence ≥ threshold: write entry to file-routes.json
   d. If confidence < threshold: add to "needs-review" list, fail validation (blocking or warning per config)
4. Write updated index.json
5. Emit validation summary (counts only: mapped/validated/inferred/needs-review/ignored)
```

### Route inference rules (priority order)

1. **Explicit taskchain context** — active child issue title/labels contain domain keywords
2. **File path prefix** — matches a known `sourceRoots` entry in `polaris.config.json`
3. **Imports/references** — file imports from a known domain package
4. **Nearby mapped files** — files in the same directory have a consistent domain → inherit
5. **Branch name** — branch contains domain slug (e.g., `pol-2` → domain `bootstrap`)
6. **Current-state.json** — active run's `tracker.target_id` → domain mapping from config

Confidence is computed from how many signals agree. Single-signal inference: low confidence. 3+ agreeing signals: high confidence.

### Backfill/bootstrap flow

`polaris map index` is a one-time full-repo scan. It is **intentionally run** and **human-approved** before writing entries. Designed for:
- First-time atlas generation on an existing repo
- Post-migration repo restructuring
- Expected output: "Mapped N files. M ignored. K need review."

`polaris map backfill` is incremental — finds files in an already-indexed repo that lack sidecar entries. Suitable for running after a large feature branch lands.

Neither command modifies source files, runtime code, or generated artifacts. All changes go to `.polaris/map/`.

---

## 3. `polaris finalize`

### Purpose

`polaris finalize` is the atomic final delivery operation. It separates loop continuation from final delivery — a key principle from the Ralph comparison (Ralph has no finalize step; EVO's step 08 is embedded in the chain). `polaris finalize` is human-runnable and agent-runnable.

### Sequence

```
1.  polaris map update --changed          # Final map validation for all session changes
2.  polaris map validate                  # Full atlas integrity check
3.  Validate current-state.json schema    # All required fields present + correct types
4.  Run targeted tests/build checks       # Configured in polaris.config.json
5.  Generate run-report.md               # Written once; never updated per-step
6.  Commit: state + map + run-report     # Single final commit
7.  git push -u origin <branch>          # Push branch
8.  Create draft PR                      # Title from run title; body includes run_id footer
9.  Write PR URL to current-state.json   # Update pr_url field
10. Append JSONL: pr-opened + pr-metadata + run-complete
11. Update Linear: run_id + branch + PR URL + validation summary comment on parent issue
12. Archive run snapshot to .polaris/runs/<run_id>/
```

### What `polaris finalize` does NOT do

- Does not re-execute children
- Does not modify source code (only map/report/state artifacts)
- Does not push to main/master directly
- Does not merge the PR — that is a human action
- Does not run if `polaris map validate` fails (fails fast at step 2)

### Run-report.md format

```markdown
# Run Report: [run_id]

**Status:** complete
**Branch:** [branch]
**PR:** [pr_url]
**Children completed:** [N] of [total]
**Validation:** passed / failed

## Children

| ID | Title | Commit | Status |
|---|---|---|---|
| POL-9 | [C1.1] Initialize minimal Polaris repo directory structure | 3a7ff0a | Done |

## Artifacts produced

- docs/spec/polaris-architecture-spec.md
- docs/spec/polaris-implementation-plan.md
- docs/planning/cluster-map.md

## Validation summary

[per-child validation results]

## Notes

[any blockers encountered, manual interventions, scope deviations]
```

---

## 4. `polaris.config.json` Schema

The configuration file lives at the repo root. All fields are optional with sensible defaults.

```json
{
  "version": "1.0",
  "repo": {
    "name": "polaris",
    "sourceRoots": ["src"],
    "docsRoots": ["docs"],
    "taskchainRoots": [".codex/skills"],
    "generatedRoots": ["node_modules", "dist", "build"],
    "sidecarOutputPath": ".polaris/map"
  },
  "map": {
    "confidenceThreshold": 0.75,
    "autoWriteAbove": 0.85,
    "reviewRequiredBelow": 0.75,
    "inferenceRules": ["taskchain-context", "path-prefix", "imports", "nearby-files", "branch-name", "run-state"],
    "onLowConfidence": "warn"
  },
  "loop": {
    "bootstrapOutputPath": ".polaris/bootstrap",
    "analyzeImplBoundaryEnforced": true,
    "sessionTerminationMode": "emit-marker"
  },
  "finalize": {
    "targetBranch": "main",
    "prDraft": true,
    "runChecks": ["npm test", "npm run lint"],
    "requireMapValidation": true,
    "requireSchemaValidation": true,
    "archiveRunSnapshot": true
  },
  "tracker": {
    "linear": {
      "enabled": true,
      "teamId": null,
      "projectId": null
    }
  },
  "integrations": {
    "github": {
      "owner": null,
      "repo": null
    }
  }
}
```

**Agent-agnostic design:** `polaris.config.json` contains no EVO-specific assumptions. EVO skills read it to populate their state, but Polaris core does not depend on EVO skill chains. A future skill set with a different chain structure can adopt Polaris by reading the same config.

---

## 5. `.polarisignore` Behavior

`.polarisignore` works like `.gitignore` for Polaris atlas indexing. Files matching `.polarisignore` patterns are **completely excluded from Polaris scope** — Polaris neither maps them, tracks them, nor reports changes to them.

### Default exclusion categories

The following are excluded by default (as if present in `.polarisignore`) and do not need to be listed explicitly:

```
# Package managers and dependency trees
node_modules/
.pnpm-store/
vendor/
Pods/

# Build outputs
build/
dist/
.build/
DerivedData/
*.xcarchive

# Language tool caches
.dart_tool/
.pub-cache/
__pycache__/
*.pyc
.gradle/

# IDE and editor
.idea/
.vscode/
*.xcworkspace

# Secrets and credentials
*.pem
*.key
*.env
.env.*
credentials.json

# Git internals
.git/
```

### Distinction: ignored vs tracked-not-indexed

Files in `.polarisignore` are **ignored** — Polaris does not know they exist.

Files in `exemptions.json` as `tracked-not-indexed` are **known to Polaris but not semantically mapped**. Polaris can report "this file changed" during changed-file validation without attempting to infer routes for it.

Lockfiles, project files, and generated manifests should typically be `tracked-not-indexed`, not ignored — because knowing they changed is operationally useful even if mapping them is not.

---

## 6. File Handling Categories

### Category A: Indexed

Semantically mapped and available to agents as part of the repo atlas. Appears in `file-routes.json` and `index.json`.

- Has `domain`, `route`, `taskchain`, `confidence`, `classification: "indexed"` fields
- Available for `polaris map query`
- Included in changed-file validation (route must still resolve)
- Examples: source files, docs, skill chains, spec files, test files, shared packages

### Category B: Tracked-not-indexed

Polaris knows the file exists and reports changes, but does not semantically map it. Appears in `exemptions.json` with `classification: "tracked-not-indexed"`.

- No domain/route inference attempted
- Changes to these files appear in changed-file reports but do not block validation
- Useful for: lockfiles, generated manifests, assets, migration SQL files

### Category C: Ignored

Polaris treats the file as completely outside mapping scope. Driven by `.polarisignore`.

- Does not appear in any Polaris output
- Changes to these files are invisible to `polaris map update --changed`
- Examples: node_modules, build outputs, binary assets, credential files

### Category assignment flow

```
For each file encountered during indexing or changed-file scan:
  1. Check .polarisignore → Ignored if matched
  2. Check exemptions.json → Tracked-not-indexed or Ignored if present
  3. Check generatedRoots in polaris.config.json → Tracked-not-indexed if matched
  4. Otherwise → attempt semantic mapping → Indexed (or Needs-Review if low confidence)
```

---

## 7. Existing-Repo Incremental Adoption Path

Polaris must deliver value immediately on existing repos without requiring a full upfront migration.

### Path A: Changed-file incremental adoption (automatic)

Every time `polaris loop continue` or `polaris finalize` runs, it calls `polaris map update --changed`. For each changed file:

- If already in `file-routes.json`: validated, last_updated refreshed
- If not indexed: inference runs; high-confidence entries auto-written; low-confidence entries queued for review
- If in exemptions.json: skipped silently

This progressively maps the repo through normal development. No migration sprint required.

### Path B: Bootstrap scan (intentional, human-approved)

When ready for a more complete atlas, a human runs:

```
polaris map index        # Full repo scan; generates draft atlas
polaris map validate     # Review needs-review entries
# Human reviews flagged entries
polaris map backfill     # Write confirmed entries
```

### Confidence thresholds

| Threshold | Behavior |
|---|---|
| ≥ `autoWriteAbove` (default 0.85) | Auto-written to file-routes.json during changed-file scan |
| ≥ `confidenceThreshold` (default 0.75) | Accepted during bootstrap; human review optional |
| < `confidenceThreshold` | Added to needs-review.json; not written until confirmed |

### Safety guarantee

Polaris never writes to source files, runtime code, generated artifacts, configuration files, or any file outside `.polaris/`. The only files Polaris mutates are:
- `.polaris/map/file-routes.json`
- `.polaris/map/exemptions.json`
- `.polaris/map/index.json`
- `.polaris/bootstrap/*.json`
- `.polaris/runs/*`
- `.taskchain_artifacts/` (when invoked by a taskchain skill)

---

## 8. Token/Context Reduction Analysis

### Baseline problem

- Analyze runs transition directly into implementation → unbounded scope expansion
- Child clusters continue inside the same session → context/history accumulates
- Agents rehydrate large artifacts each step
- Result: token usage grows unbounded across long sessions

### Expected savings by Polaris component

#### `polaris loop` structural session reset

**Polaris reduction:** Each child runs in a fresh session. Bootstrap packet is ≈2–5k tokens. History starts fresh per child.

**Estimated reduction:** 60–80% of conversation history tokens per session.

#### Compact bootstrap packet

**Polaris reduction:** Bootstrap packet is ≈2–5k tokens vs. full conversation summaries of 5–15k tokens.

**Estimated reduction:** 40–60% of session startup context per resumed session.

#### Sidecar map replacing broad discovery

**Polaris reduction:** `polaris map query src/cli` → single file read, 200 tokens, returns domain/route/taskchain/confidence.

**Estimated reduction:** 50–70% of per-session repo orientation cost.

#### Separated loop/finalize responsibilities

**Polaris reduction:** `polaris finalize` is a separate session with only final-delivery scope.

**Estimated reduction:** 15–25k tokens removed from last-child sessions.

### Estimated total reduction for a 4-child cluster

| Source | Current cost | With Polaris | Reduction |
|---|---|---|---|
| Conversation history (per session) | ~25k tokens avg | ~5k tokens | ~80% |
| Session startup orientation | ~15k tokens avg | ~5k tokens | ~67% |
| Repo discovery per session | ~12k tokens avg | ~2k tokens | ~83% |
| Final delivery session overhead | ~20k tokens | ~8k tokens | ~60% |
| **Total (4 children)** | **~288k tokens** | **~80k tokens** | **~72%** |

These are directional estimates. Actual savings depend on cluster complexity and repo size.

### Tradeoffs

| Tradeoff | Description |
|---|---|
| Session startup overhead | Each fresh session re-reads skill chain, routing, bootstrap packet (~5–10k tokens). Net positive, but not zero. |
| Map staleness risk | If `.polaris/map/` is not committed promptly, resumed sessions may read stale route entries. Mitigation: `polaris loop continue` always commits map changes. |
| Low-confidence mapping ambiguity | Incorrect route inference can send agents to wrong files. Mitigation: confidence thresholds + needs-review queue. |
| Bootstrap packet staleness | If an agent writes state but doesn't call `polaris loop continue`, the bootstrap packet is stale. Mitigation: `polaris loop status` shows if packet is stale. |
| Tool dependency | Polaris requires a CLI tool or MCP integration available in the execution environment. |
