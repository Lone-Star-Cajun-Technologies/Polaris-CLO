# Polaris Usage Guide

This guide covers the day-to-day commands for running governed AI agent workflows with Polaris.

---

## Core Concepts

| Term | Description |
|---|---|
| **Cluster** | A parent issue plus its set of child work items |
| **Child** | A single bounded unit of implementation work |
| **Run** | A single orchestration session that dispatches and tracks children |
| **Lifecycle state** | A normalized status (backlog, in_progress, in_review, done, blocked, cancelled) |
| **Smart Docs** | Per-route instruction files that govern how workers operate on each code area |

---

## Daily Workflow

### 1. Start or continue a run

```bash
polaris run POL-123
```

Polaris will:
- Resolve the active cluster and its open children
- Dispatch the next child to your configured worker provider
- Update the tracker state (if configured)
- Record telemetry in `.polaris/runs/`

### 2. Check current status

```bash
polaris status
```

Shows the active run, cluster, current child, and tracker sync state.

```bash
polaris status --verbose
```

Shows per-child status and the full execution graph.

### 3. Finalize a completed run

Once all children are done:

```bash
polaris finalize
```

Finalize will:
- Validate the map and schema
- Create a delivery PR (if GitHub integration is configured)
- Post a completion comment to the parent issue in your tracker
- Transition the parent issue to "In Review" (if your tracker supports it)
- Archive cognition notes

---

## Running a Specific Child

```bash
polaris run POL-123 --child POL-124
```

Forces dispatch of a specific child rather than the next unstarted one.

---

## Tracker Commands

```bash
# Force sync the active cluster with the tracker
polaris tracker sync

# Inspect which lifecycle transitions are available for an issue
polaris tracker transitions POL-123
```

---

## Smart Docs

Smart Docs are instruction files (`.polaris/docs/<route>/instructions.md`) that tell workers how to handle a specific code area. They are generated during `polaris init --adopt` and can be edited by hand.

```bash
# Ingest new documentation into Smart Docs
polaris docs ingest --source <path>

# Promote staged Smart Docs
polaris docs promote
```

### Reformatting existing smartdocs to OKF structure

If you already have a `smartdocs/` directory and want to reformat its content into the OKF structure (per-directory `index.md` with `okf_version` frontmatter) without running the full 8-phase `polaris adopt` or touching any agent instruction files (`CLAUDE.md`, `AGENTS.md`, etc.), use:

```bash
# Preview what will change (safe — writes nothing)
polaris docs reformat-okf --dry-run

# Apply the migration
polaris docs reformat-okf
```

This single command is equivalent to running these three commands in sequence:

```bash
polaris docs migrate                   # move scattered markdown into smartdocs/raw/
polaris docs seed-index --all          # write index.md (with okf_version frontmatter) to each smartdocs/ sub-directory
polaris docs seed-instructions --all   # write POLARIS.md drafts for directories that lack one
```

Agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.agents/`, `.codex/`, `.claude/`) are never modified by any of the above commands.

After reformatting you can validate the result with:

```bash
polaris docs validate-instructions
```

---

## Configuration Reference

All configuration lives in `polaris.config.json` at the repository root.

### Execution

```json
{
  "execution": {
    "adapter": "terminal-cli",
    "providers": {
      "copilot": {
        "command": "copilot",
        "args": ["-p", "{{worker_prompt}}"]
      }
    },
    "rotation": ["copilot"]
  }
}
```

`{{worker_prompt}}` is substituted with the full worker instruction packet at dispatch time.

### Budget

```json
{
  "budget": {
    "mode": "fixed-cap",
    "max_children": 5,
    "stop_on_fail": false
  }
}
```

| Mode | Behavior |
|---|---|
| `fixed-cap` | Stop after `max_children` children per session |
| `run-until-done` | Run all open children with no cap |
| `stop-on-fail` | Halt immediately when any child fails |

### Loop

```json
{
  "loop": {
    "bootstrapOutputPath": ".polaris/bootstrap",
    "analyzeImplBoundaryEnforced": true,
    "sessionTerminationMode": "emit-marker",
    "allowBranchDivergence": false
  }
}
```

---

## Compaction

Compaction controls how aggressively Polaris trims orchestrator and worker context as conversations grow.

```json
{
  "compact": {
    "orchestratorMode": "standard",
    "workerMode": "standard"
  }
}
```

| Mode | Description |
|---|---|
| `standard` | Default — balanced trimming |
| `strict` | Aggressive — prune hard to stay within budget |
| `minimal` | Preserve as much context as possible (workers only) |

---

## Lifecycle Policy

Fine-tune which transitions Polaris performs automatically on your tracker:

```json
{
  "tracker": {
    "lifecyclePolicy": {
      "childOnDispatch": "in_progress",
      "childOnValidationPassed": "in_review",
      "childOnMerged": "done",
      "parentOnAllChildrenComplete": "in_review",
      "providerFailureBeforeWork": "no_status_change"
    }
  }
}
```

Use `"no_status_change"` for any event you want Polaris to skip without touching the tracker.

---

## Run Artifacts

All run artifacts are written under `.polaris/`:

```text
.polaris/
  clusters/          # cluster state per issue
  runs/              # per-run telemetry and ledger
  map/               # file-route ownership map
  bootstrap/         # worker bootstrap packets
  cognition/         # pending and archived cognition notes
  adoption-plan.json # adoption plan state
```

These directories are excluded from git by default (added to `.gitignore` during `polaris init`).

---

## Troubleshooting

**Config errors**
```bash
polaris doctor
```
Reports missing required fields, invalid adapter config, or unreachable tracker credentials.

**Stuck run**
If a run is stuck mid-dispatch, check `.polaris/runs/<run-id>/telemetry.jsonl` for the last recorded event, then re-run:
```bash
polaris run POL-123 --resume
```

**Tracker sync failures**
Verify your token is set and has the right scopes:
```bash
polaris tracker test
```
