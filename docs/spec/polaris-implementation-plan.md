> Source: git-fit/docs/evonotes/planning-specs/ — canonical Polaris architecture reference

# Polaris Implementation Plan

**Status:** Analysis deliverable
**Parent:** POL-1
**Inputs:** `docs/spec/polaris-architecture-spec.md`, `docs/raw/ralph-evo-comparison.md`

---

## Section 1 — Failure Modes and Tradeoffs

### FM-01: Stale Sidecar Map

**Description:** The `.polaris/map/file-routes.json` atlas reflects repo state at last index/update time. Files moved, renamed, or deleted since the last `polaris map update` will have stale entries. Agents navigating via the atlas will be sent to wrong locations or receive 404s.

**Likelihood:** Medium-High — any refactor, rename, or move without running `polaris map update --changed` produces staleness.

**Severity:** Medium — navigational errors cause wasted tool calls and context spend, but do not corrupt execution state. Agents will discover the file is missing and self-correct. No data loss.

**Mitigation:**
- `polaris loop continue` always runs `polaris map update --changed` before emitting the bootstrap packet
- `polaris finalize` runs `polaris map validate` and fails fast if stale entries exist
- `polaris map validate` provides a `--stale-threshold=Nd` flag to warn on entries older than N days
- Git pre-commit hook (optional): run `polaris map update --changed` on staged files

---

### FM-02: Incorrect Route Inference

**Description:** Route inference uses heuristics (file path, imports, branch name, active child context). Heuristics can produce incorrect domain/route assignments, causing agents to treat a file as belonging to the wrong taskchain or domain.

**Likelihood:** Low-Medium — high-confidence entries (≥0.85) should be correct >95% of the time. Lower confidence entries are queued for review. Errors mostly occur at domain boundaries.

**Severity:** Medium — an agent working on domain A but reading domain B's route annotations may make incorrect scope assumptions. Does not corrupt state but can cause scope drift.

**Mitigation:**
- Confidence thresholds prevent low-confidence entries from auto-writing
- `needs-review.json` queue surfaces ambiguous entries for human confirmation
- `polaris.config.json` `sourceRoots` configuration narrows inference scope
- Entries can be manually corrected in `file-routes.json` — sidecar-only, no source file mutation
- On incorrect inference detected by agent: `polaris map validate --fix [path]` allows human correction

---

### FM-03: Low-Confidence Mapping Ambiguity

**Description:** When `polaris map update --changed` encounters a file with confidence below `confidenceThreshold` (default 0.75) and cannot infer a route, it blocks validation (configurable: warn or fail). If many files are below threshold, this produces a large `needs-review.json` backlog that humans are slow to clear.

**Likelihood:** Medium — most common during first few months of adoption before the atlas is substantially populated. Decreases over time as coverage grows.

**Severity:** Low-Medium — `warn` mode (default) does not block execution, just surfaces files. `fail` mode blocks `polaris finalize` until resolved.

**Mitigation:**
- Default to `warn` for changed-file scan; `fail` only for finalize
- `polaris.config.json` `generatedRoots` pre-classifies whole directories as tracked-not-indexed, reducing the pool of files that need semantic mapping
- `.polarisignore` removes noise entirely
- Provide a `polaris map approve-pending` command for bulk-approving queued entries with human review
- Track coverage metrics in `index.json`; expose as `polaris map status` report

---

### FM-04: Context Poisoning Through Wrong State Packet

**Description:** A bootstrap packet generated from a stale or corrupted `current-state.json` sends a fresh session to the wrong step, wrong child, or wrong branch. The agent resumes from an incorrect state and may execute already-done work or skip required work.

**Likelihood:** Low — bootstrap packets are generated from `current-state.json` at checkpoint time. Requires `current-state.json` to be corrupt or stale at generation time.

**Severity:** High — a wrong resume step can cause duplicate commits, double Linear updates, or skipped children. May require manual state repair.

**Mitigation:**
- `polaris loop continue` validates `current-state.json` against schema before generating bootstrap packet
- Bootstrap packet includes a `current_state_sha` field (hash of current-state.json at generation time); resumed session verifies hash match before acting
- If hash mismatch detected on resume: halt and report "state packet stale — re-run `polaris loop status` to verify current state"
- `current-state.json` is updated atomically (write to `.tmp`, rename) to prevent partial writes

---

### FM-05: Loop Deadlocks

**Description:** A child issue cannot be executed because its dependencies are not Done, but the dependency is also blocked. The loop halts on step 03 (select-child) finding no executable child.

**Likelihood:** Low-Medium — primarily occurs when a dependency is blocked mid-cluster and the operator does not resolve it.

**Severity:** Medium — execution stops. No data corruption, but forward progress halts until manual intervention.

**Mitigation:**
- `polaris loop continue` in `all-blocked` state emits `{"event": "loop-deadlock-detected"}` and halts with an explicit message listing blocked children and their unresolved blockers
- Does NOT loop — single detection and halt
- `polaris loop status` shows deadlock state and the specific blocking conditions
- Operator resolves blocker in Linear, then resumes via `polaris loop resume`

---

### FM-06: Runaway Child Continuation

**Description:** `polaris loop continue` keeps spawning fresh sessions and executing children without human review of intermediate artifacts. High token/cost burn from unsupervised execution.

**Likelihood:** Medium — occurs when loop is invoked in a fully-automated context (CI/CD, scheduled job) without human-in-the-loop checkpoints.

**Severity:** High — can produce large uncommitted code changes, large Linear issue updates, and high token costs without operator visibility.

**Mitigation:**
- Analyze→implementation boundary enforcement is a hard stop
- `polaris.config.json` `maxChildrenPerSession` cap (default 4)
- `requireHumanApprovalBetween: ["analyze", "implement"]` config flag for explicit operator confirmation checkpoint
- `polaris loop continue --dry-run` shows what next session would do without executing
- All loop continuations logged to JSONL

---

### FM-07: Analyze→Implementation Scope Creep

**Description:** An analyze session identifies a gap and the agent "helpfully" begins fixing it — writing code, modifying configs, or creating infrastructure files within the analyze session. The session boundary is violated without Polaris being invoked to enforce it.

**Likelihood:** Medium — agents sometimes violate analyze/implement scope boundaries when they detect actionable gaps.

**Severity:** Medium-High — partial implementation in an analyze session is often incomplete, untested, and creates dirty state that conflicts with the proper implementation session.

**Mitigation:**
- Polaris loop enforces boundary structurally at session-type level (not just instructional)
- Analyze session type is declared in bootstrap packet; `polaris loop continue` checks for any non-doc file mutations before accepting the checkpoint
- `.polaris/session-type: analyze` file written at analyze session start; `polaris loop continue` reads this to enforce scope
- Implementation-type tool calls in an analyze session generate audit events surfaced in `polaris loop status`

---

### FM-08: Stale Branch/Worktree State

**Description:** The bootstrap packet specifies a branch that no longer exists, has been force-pushed, or has diverged from the expected base.

**Likelihood:** Low — primarily occurs when the branch was manually deleted between sessions or force-pushed.

**Severity:** Medium-High — commits on stale history produce conflicts on PR. May require cherry-pick or rebase.

**Mitigation:**
- `polaris loop resume` verifies branch exists on remote before generating the session start signal
- Bootstrap packet includes `base_sha`; resumed session verifies before committing
- If branch diverged: halt and report "branch HEAD changed since checkpoint — verify with `git log` before resuming"
- `polaris.config.json` `allowBranchDivergence: false` (default) causes hard halt

---

### FM-09: Over-Indexing Sensitive or Generated Files

**Description:** `polaris map index` or `polaris map backfill` maps secrets files, credential configs, generated code, or binary assets as semantically indexed entries.

**Likelihood:** Low — primarily a configuration error (missing `.polarisignore` entries).

**Severity:** High for secrets — if a credentials file is indexed and an agent reads it following an atlas pointer, sensitive data enters the context window.

**Mitigation:**
- Default `.polarisignore` exclusions cover common sensitive/generated patterns
- `polaris map index` applies `.polarisignore` before any inference
- `polaris map validate` checks for entries matching common secret file patterns and emits HIGH severity warnings
- Security review step in `polaris finalize` scans `file-routes.json` for sensitive pattern matches before committing

---

### FM-10: Under-Indexing Important Files

**Description:** Key source files, test files, or docs are not mapped in the atlas because they were never touched by a session running `polaris map update --changed`.

**Likelihood:** Medium — proportional to how new the atlas is. Decreases over time.

**Severity:** Low-Medium — agents fall back to direct file reads and grep. Performance degrades toward pre-Polaris baseline but correctness is not affected.

**Mitigation:**
- `polaris map index` (periodic human-run) produces a full-coverage first pass
- `polaris map backfill` fills gaps for already-indexed repos
- `polaris map status` reports coverage percentage and top-N unmapped domains
- Coverage targets configurable in `polaris.config.json`

---

## Section 2 — Architecture Recommendation

### Recommendation: Shared Taskchain Orchestration Layer

Polaris should be implemented as a **shared taskchain orchestration layer** — neither a standalone runtime nor a simple evo-run extension, but a shared infrastructure tool that all EVO skills and future taskchained workflows consume.

### Evidence supporting this recommendation

**Evidence 1 — Multiple EVO skill consumers require the same capabilities**
Structural session reset, repo atlas, and finalize-as-CLI are needed by evo-run, evo-analyze, evo-plan, evo-closeout, and docs-ingest. Embedding loop/map/finalize inside evo-run alone would require duplicating these capabilities across all other skills.

**Evidence 2 — Sidecar map is a repo-level concern, not a skill-level concern**
The sidecar atlas in `.polaris/map/` maps files to route/domain/taskchain ownership for the entire repo. No single skill owns this concern.

**Evidence 3 — Bootstrap packet is session-infrastructure, not skill logic**
The bootstrap packet format, session-type enforcement, and context reset mechanism require state that spans multiple skills and sessions.

**Evidence 4 — `polaris finalize` must be human-runnable and agent-runnable independently**
A human cannot invoke EVO's step 08 directly. `polaris finalize` as a standalone tool fixes this without modifying evo-run.

**Evidence 5 — Ralph analysis confirms infrastructure-level separation is correct**
Ralph achieves structural session separation at the OS process level — `ralph.sh` is the loop runner, not the agent. Polaris follows the same architecture.

### Why not standalone runtime?

A fully standalone Polaris runtime would require rebuilding Linear integration, governed execution chains, and blocker protocols that EVO already has. Polaris should complement EVO, not replace it.

### Why not evo-run extension only?

Coupling Polaris only to evo-run would leave evo-analyze, evo-plan, and docs-ingest without structural session boundaries and repo navigation.

---

## Section 3 — Ordered Implementation Issue Tree

### Summary

Implementation is viable. The combination of Polaris (loop/map/finalize infrastructure) + EVO (governed execution chains, Linear integration, step sequencing, blocker protocols) produces a significantly better architecture.

### Cluster Map

Issues are ordered sequentially in 7 clusters (POL-2 through POL-8). Each cluster depends on all prior clusters unless noted. See `docs/planning/cluster-map.md` for the full dependency map.

---

**Cluster 1 (POL-2): Bootstrap repo structure and temporary taskchain harness**
*Scope:* Create skeleton directory structure, CLAUDE.md/AGENTS.md, planning doc copies, temporary bootstrap skill, artifact scaffold.
*Deps:* None

---

**Cluster 2 (POL-3): Polaris CLI / config / ignore foundation**
*Scope:* Create `polaris` CLI entry point (Node.js/TypeScript), `polaris.config.json` schema + validator, `.polarisignore` parser, config loader with defaults. `polaris --version` returns version string.
*Deps:* POL-2

---

**Cluster 3 (POL-4): Polaris map — index / backfill / update / validate**
*Scope:* Implement `polaris map index`, `polaris map backfill`, `polaris map update --changed`, `polaris map validate`, `polaris map query`. Produce `.polaris/map/` with `file-routes.json`, `exemptions.json`, `index.json`.
*Deps:* POL-3

---

**Cluster 4 (POL-5): Polaris loop — checkpoint / resume / boundary enforcement**
*Scope:* Implement `polaris loop continue`, `polaris loop status`, `polaris loop resume`, `polaris loop abort`. Implement analyze→implementation boundary enforcement.
*Deps:* POL-4

---

**Cluster 5 (POL-6): Polaris finalize — atomic delivery sequence**
*Scope:* Implement full 12-step finalize sequence: map validate, schema validate, targeted checks, run-report generation, commit, push, draft PR, state update, JSONL closeout, Linear update, archive.
*Deps:* POL-5 (loop), POL-4 (map)

---

**Cluster 6 (POL-7): EVO skill integration — evo-run and evo-analyze**
*Scope:* Update evo-run step 07 to call `polaris loop continue` on STOP/all-done. Update evo-run step 08 to use `polaris finalize`. Update evo-analyze to use Polaris loop/map. Replace bootstrap-run skill with native Polaris taskchain.
*Deps:* POL-5, POL-6

---

**Cluster 7 (POL-8): Adoption — git-fit atlas and guide**
*Scope:* Run `polaris map index` on git-fit, review needs-review entries, complete `polaris.config.json` for git-fit, write `.polarisignore` for git-fit, publish adoption guide.
*Deps:* POL-4 (polaris map index functional)

---

### Dependency graph

```text
POL-2 (Cluster 1: Bootstrap)
  └── POL-3 (Cluster 2: CLI/config/ignore)
        └── POL-4 (Cluster 3: Map)
              └── POL-5 (Cluster 4: Loop)
                    ├── POL-6 (Cluster 5: Finalize)
                    │     └── POL-7 (Cluster 6: EVO integration)
                    └── POL-7 (Cluster 6: EVO integration)

POL-8 (Cluster 7: Adoption) ← POL-4 only
```

### Phased delivery

| Phase | Clusters | What it delivers |
|---|---|---|
| 1 — Core infrastructure | POL-2, POL-3, POL-4 | Repo CLI, atlas: index + changed-file mapping |
| 2 — Loop and session management | POL-5, POL-6 | Bootstrap packets, boundary enforcement, finalize |
| 3 — EVO skill integration | POL-7 | Full EVO skill chain adoption |
| 4 — Adoption | POL-8 | git-fit atlas populated; guide published |

Phase 1 delivers standalone value (repo map) independent of EVO skill chain changes.
