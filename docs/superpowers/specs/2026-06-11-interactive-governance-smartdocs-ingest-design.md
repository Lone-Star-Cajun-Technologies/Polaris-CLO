# Interactive Governance for Smart Docs Ingest

**Date:** 2026-06-11
**Status:** approved
**Scope:** new `src/governance/` module + `smartdocs-engine/ingest.ts` integration

---

## Problem

During large-scale repository adoption, `docs-ingest` classified and routed documents without
surfacing review packets when authority decisions were ambiguous. Documents landed in
`smartdocs/doctrine/active/` without user approval because:

1. `classifyDoc` returned a flat classification with no confidence signal.
2. `doctrine-candidate` was mapped to `smartdocs/doctrine/active/` in `TARGET_DIRS` (bug).
3. No governance layer existed to distinguish "I don't know what this is" from "I know what
   this is but assigning authority would be unsafe."

The intended Polaris governance model is:

```
Discover → Analyze → Ask when uncertain → Mutate safely → Execute
```

Polaris must never silently assign canonical authority.

---

## Design Goals

1. Preserve existing safety guarantees.
2. Prevent silent authority assignment.
3. Minimize user review burden through intelligent grouping.
4. Scale to large repositories (1000+ documents).
5. Remain tracker-agnostic and model-agnostic.
6. Establish governance as a general Polaris primitive, not a docs-ingest special case.

---

## Lifecycle Model

Seven states with a hard distinction between `candidate` and `review-required`:

```
raw
  → classified        ingest run assigns classification + confidence + authority risk
  → review-required   "I cannot safely determine whether this should become authoritative"
  → candidate         "I know what this is, but it is not canonical yet"
  → active            canonical — user-approved
  → implemented       terminal — spec fulfilled
  → deprecated        terminal — doctrine retired
```

**`candidate`** is a known, confidence-high classification awaiting canonicalization.
Candidate files route to `smartdocs/doctrine/candidate/` only. They do not move to active
zones without explicit user approval.

**`review-required`** is a holding state. Nothing in `review-required` has been assigned
authority. It awaits a human routing decision. It is not a permanent home.

---

## Routing Decision Table

| classificationConfidence | destinationCertainty | authorityRisk | Outcome |
|---|---|---|---|
| ≥ threshold | ≥ threshold | low | auto-route |
| ≥ threshold | ≥ threshold | medium | candidate + review packet |
| ≥ threshold | < threshold | medium | review-required + review packet |
| ≥ threshold | any | high | review-required + review packet |
| < threshold | any | any | review-required + review packet |

Default thresholds: `confidence: 0.75`, `destinationCertainty: 0.70`. Configurable per run.

**Escalation triggers** (always produce `review-required` regardless of thresholds):
- Target path is a high-authority zone (`doctrine/active/`, `architecture/`, `decisions/`)
- Doctrine conflict detected against `doctrine/active/` (per-document; does not halt run)
- Duplicate filename already exists at proposed destination
- Document `status: deprecated` but classification is not `deprecated-noise`

**Run halt conditions** (systemic failure, not per-document):
- `smartdocs/` not found
- Authority map broken or config invalid
- `run-start` telemetry write fails

---

## Architecture

### New module: `src/governance/`

Governance decides: confidence, authority risk, whether review is required, review packet shape.
Smart Docs decides: document parsing, docs-specific classification inputs, final filesystem
destination, Smart Docs folder conventions.

`ingest.ts` must not own the rule "high authority risk requires review." It asks governance
for that decision.

**Files:**

```
src/governance/types.ts          shared types — no dependencies on smartdocs-engine
src/governance/authority-risk.ts (classification, destinationPath) → AuthorityRisk
src/governance/routing.ts        route(result, thresholds) → RoutingDecision
src/governance/review-packet.ts  build, write (JSON + MD), read, apply decisions
src/governance/index.ts          re-exports

src/governance/authority-risk.test.ts
src/governance/routing.test.ts
src/governance/review-packet.test.ts
```

### Types (`src/governance/types.ts`)

```typescript
export type AuthorityRisk = "low" | "medium" | "high";
export type ReviewRecommendation = "approve" | "reject" | "defer";
export type RoutingOutcome = "auto-route" | "candidate" | "review-required";

export interface ClassificationResult {
  classification: string;           // opaque — caller defines vocabulary
  classificationConfidence: number; // clamped 0.0–1.0
  destinationCertainty: number;     // clamped 0.0–1.0
  authorityRisk: AuthorityRisk;
  reasoning: string[];
}

export interface RoutingThresholds {
  confidence: number;
  destinationCertainty: number;
}

export interface RoutingDecision {
  outcome: RoutingOutcome;
  reviewPacket?: ReviewPacket;
}

export interface ReviewPacket {
  sourcePath: string;
  proposedDestination: string;
  classificationConfidence: number;
  destinationCertainty: number;
  authorityRisk: AuthorityRisk;
  reasoning: string[];
  conflicts: string[];
  recommendation: ReviewRecommendation;
  outcomeReason: string;
  // Populated after human review:
  reviewDecision?: ReviewRecommendation;
  reviewedAt?: string;
  reviewedBy?: string;
}
```

### Authority risk (`src/governance/authority-risk.ts`)

Takes `(classification: string, proposedDestinationPath: string) → AuthorityRisk`.
Path wins when classification and path disagree, because authority is created by where
the artifact lands.

**High authority risk zones:**
- Any path under `doctrine/active/`
- Any path under `architecture/`
- Any path under `decisions/`
- Any path under `specs/active/`

**Medium authority risk zones:**
- Any path under `doctrine/candidate/`
- Provenance updates

**Low authority risk zones:**
- `runtime/`
- `audits/`
- Summaries
- Telemetry-derived artifacts

### Routing (`src/governance/routing.ts`)

```typescript
export function route(
  result: ClassificationResult,
  thresholds: RoutingThresholds
): RoutingDecision
```

Pure function, no I/O. Implements the five-row decision table exactly. Returns `RoutingDecision`
with `outcome` and, when not auto-route, a populated `ReviewPacket` including `outcomeReason`.

### Review packets (`src/governance/review-packet.ts`)

- `buildReviewPacket(result, destination, conflicts): ReviewPacket`
- `writeReviewQueue(packets, dir): void` — writes both `_review-queue.json` (canonical) and
  `_review-queue.md` (human view rendered from JSON)
- `readReviewQueue(jsonPath): ReviewPacket[]` — reads from JSON only; never parses markdown
- `applyReviewDecisions(pending, reviewed): ReviewPacket[]` — merges user decisions

JSON is canonical. Markdown is a rendered projection. Ingest reads JSON; markdown is for humans.

---

## Changes to `smartdocs-engine/ingest.ts`

### Bug fix
`TARGET_DIRS["doctrine-candidate"]` currently maps to `smartdocs/doctrine/active`. Change to
`smartdocs/doctrine/candidate`.

### `classifyDoc` → `classifyDocWithConfidence`

```typescript
function classifyDocWithConfidence(
  content: string,
  filePath: string
): ClassificationResult
```

Returns `ClassificationResult` with clamped confidence scores and reasoning strings.

**Score computation:**

`classificationConfidence`:
- Explicit frontmatter `doc-type:` field → +0.4
- Frontmatter `authority:` or `status:` aligns with inferred classification → +0.2
- Multiple independent keyword signals → +0.2 to +0.3
- Single weak keyword match → results in 0.3–0.5
- No signals, defaulted to `spec-raw` → 0.3
- Clamped: `Math.min(score, 1.0)`

`destinationCertainty`:
- Frontmatter names a specific map area or route explicitly → +0.4
- `linkedMapArea` resolved from atlas routes → +0.3
- Filename or path includes a recognizable domain keyword → +0.2
- No map linkage, no domain signal → 0.2–0.3
- Clamped: `Math.min(score, 1.0)`

### Removal of `APPROVAL_REQUIRED`

The `APPROVAL_REQUIRED` set is removed. The governance module owns this logic via
`authority-risk.ts` and `routing.ts`.

### New `IngestOptions` fields

```typescript
interactive?: boolean;                    // default false
confidenceThreshold?: number;             // default 0.75
destinationCertaintyThreshold?: number;   // default 0.70
```

### Review packet accumulation

Packets accumulate during the batch run. On completion:
- If any packets exist: call `writeReviewQueue` → writes `smartdocs/raw/_review-queue.json`
  and `smartdocs/raw/_review-queue.md`
- If `interactive: true`: after each review-required classification, print packet to stdout
  and prompt `[approve/reject/defer]` before continuing; decisions written to queue file
  incrementally

Run exits 0 whether or not a review queue was written. A review queue is governance output,
not a failure.

### New `IngestResult` fields

```typescript
routingDecision: RoutingOutcome;
reviewPacket?: ReviewPacket;
```

---

## CLI Changes

```
npm run polaris -- docs ingest [options]

New flags:
  --interactive                     blocking prompts for review-required docs
  --confidence-threshold <n>        float 0–1, default 0.75
  --destination-certainty-threshold <n>  float 0–1, default 0.70

Modified flag:
  --approve-authority               now requires explicit scope:
    --approve-authority --file <path>
    --approve-authority --from-review-queue
    --approve-authority --decision-id <id>
```

`--approve-authority` without a scope argument is a hard error. It must not silently approve
every authority-bearing document in a batch. This is a **breaking change** for any automation
that calls `docs ingest --approve-authority` without scope.

---

## Review Queue Format

### JSON (`_review-queue.json`)

```json
{
  "generated_at": "<ISO timestamp>",
  "run_id": "<run id>",
  "packets": [ /* ReviewPacket[] */ ]
}
```

### Markdown (`_review-queue.md`)

Grouped by classification, sorted by `authorityRisk` descending within each group, then by
`linkedMapArea` to place similar documents adjacent. Near-duplicate titles within a group
are flagged with a `⚠ possible duplicate` note.

Sample entry:

```markdown
## review-required · doctrine-candidate · HIGH authority risk

**Source:** docs/decisions/auth-model.md
**Proposed destination:** smartdocs/doctrine/active/auth-model.md
**Classification confidence:** 0.82
**Destination certainty:** 0.65
**Outcome reason:** High authority risk destination requires user approval; destination certainty below threshold.

**Reasoning:**
- frontmatter `authority: doctrine` present
- contains `must never` and `always` behavioral assertions (3 matches)

**Conflicts:** none detected

**Recommendation:** approve
**Review decision:** ← set this to `approve`, `reject`, or `defer`
```

---

## Unattended Execution Model

Default behavior (no `--interactive`):

```
docs-ingest runs
  for each file:
    classify → score → route decision
    auto-route:       move file, update atlas, emit telemetry
    candidate:        move to doctrine/candidate/, emit review packet
    review-required:  leave file in raw/, emit review packet
  on completion:
    if review packets exist → write _review-queue.json + _review-queue.md
    emit summary: N auto-routed, M candidates, K review-required
    exit 0
```

**Resumable review cycle:**

```
user edits _review-queue.md (sets reviewDecision fields)
  → reruns docs-ingest
  → ingest reads _review-queue.json, applies decisions before classifying new files
  → approved items route to proposed destination
  → rejected items return to raw/ with rejection stamp in frontmatter
  → deferred items remain in queue for next run
```

---

## Bulk Adoption Strategy

- Batching stays at `maxFiles` per run (default 4). Queue accumulates across runs.
- For initial EVO-scale adoption: use default unattended mode, not `--interactive`.
  Let the queue build over multiple runs; review as a batch when ready.
- Queue grouping reduces review fatigue: same classification together, highest authority
  risk first, same map area adjacent, duplicate flags visible.
- Polaris proposes; it does not decide. Every `review-required` packet ends with a
  recommendation, not a fait accompli.

---

## Migration

### Existing `doctrine/active/` files
No automatic migration. Existing active doctrine is not retroactively moved. To audit for
misrouted files: run `polaris docs audit --check-provenance` to flag any active doctrine
files whose provenance records `classified-as: doctrine-candidate` — those are candidates
for re-review.

### Existing automation using `--approve-authority`
Breaking change. Replace with `--approve-authority --from-review-queue` and run an initial
review cycle to approve the queue before resuming automation.

### Repositories with no `_review-queue.json`
No migration needed. Ingest reads the queue if present; starts fresh if absent.

---

## What This Is

This design determines that interactive governance is **all three** possibilities from the
issue:
- An enhancement to `docs-ingest` (integration point, bug fix, CLI flags)
- A new Polaris capability (`src/governance/` module)
- A new Smart Docs subsystem (review queue, lifecycle state `review-required`)

The governance module is the canonical approach for handling uncertainty during any Polaris
workflow that involves authority assignment — not only Smart Docs ingest.
