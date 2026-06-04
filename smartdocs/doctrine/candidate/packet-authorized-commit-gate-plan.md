<!-- polaris:doctrine-candidate -->
# Packet-Authorized Commit Gate Plan

**Status:** Raw planning note  
**Created:** 2026-05-29  
**Area:** Polaris governance / packet authorization / GitHub integration

## Purpose

Capture a possible future enforcement layer where Polaris becomes the only trusted path for creating governed commits and pull requests.

This does not try to prevent an agent from editing files locally. Instead, it prevents unauthorized or unsealed work from becoming official repository history without Polaris validation.

## Problem

Recent runs showed that an agent can bypass Polaris by implementing inline instead of entering through the expected Polaris path.

Example bypass:

1. Agent reads issue or prompt directly.
2. Agent edits files directly.
3. Agent commits directly.
4. Polaris never observes packet issuance, worker assignment, acknowledgment, heartbeat, or result.

In that case:

- Git knows files changed.
- The agent knows it implemented.
- Polaris may not know the work happened.

This means the Foreman seal and skill packet model are only reliable if the agent enters through Polaris.

## Proposed Direction

Configure agents and repositories so that agents do not create governed commits directly.

Instead:

1. Agent receives a Polaris skill packet or worker packet.
2. Agent performs the allowed work.
3. Agent returns a result containing the packet ID.
4. Polaris validates the packet ID, scope, changed files, tests, and deliverables.
5. Polaris creates the commit and eventually the PR.

## Core Rule

Governed work requires a Polaris-issued packet ID.

Work without a valid packet ID may still be useful, but it is treated as manual/unsealed work until reconciled.

## Possible Enforcement Layers

### 1. Agent Instruction Layer

Repo-level instructions should tell agents:

- Do not run `git commit` directly.
- Do not create PRs directly.
- Use Polaris finalize/closeout for governed work.
- Polaris owns commit and PR creation.

This is behavioral and not sufficient by itself, but it shapes model behavior.

### 2. Polaris Finalize Layer

Add a command such as:

```bash
polaris finalize --packet-id <packet_id>
```

or:

```bash
polaris closeout --packet-id <packet_id>
```

Polaris should validate:

- packet ID exists
- packet is current
- packet role matches the action
- changed files are within allowed scope
- required result artifact exists
- required tests passed
- Linear issue/cluster mapping is valid

If valid, Polaris creates the commit.

### 3. Git Hook Layer

Add an optional pre-commit or commit-msg hook that warns or rejects commits missing Polaris authorization metadata.

Example commit metadata:

```text
Polaris-Packet-ID: pkt_...
Polaris-Run-ID: ...
Polaris-Child-ID: ...
```

This is not bulletproof because local hooks can be disabled, but it is useful guardrail behavior.

### 4. GitHub Integration Layer

Eventually Polaris can use GitHub APIs to:

- create commits
- open PRs
- attach packet/run metadata
- link PRs back to Linear
- label unsealed/manual work

This makes GitHub history reflect Polaris authority.

## Important Distinction

This plan does not need to block local file edits.

The key distinction is:

- local edits are allowed but untrusted
- governed commits require Polaris authorization

This is the same pattern as packetized worker execution: the model may act, but Polaris decides whether the work becomes trusted state.

## Benefits

- Prevents inline implementation from masquerading as sealed worker execution.
- Gives closeout a concrete packet ID to validate.
- Makes commits auditable.
- Creates a future bridge to GitHub and EVOconnect.
- Keeps Polaris as the runtime authority.

## Open Questions

- Should Polaris create commits directly, or only validate and approve them?
- Should commit hooks reject missing packet IDs or only warn at first?
- How should manual/user-authored commits be represented?
- Should PR creation require packet authorization?
- How should emergency hotfixes bypass the gate?
- Should unsealed work be auto-labeled in GitHub?

## Suggested Phases

### Phase 1: Documentation and Agent Policy

Add repo-level guidance:

- agents should not commit directly
- governed work must go through Polaris closeout/finalize

### Phase 2: Packet ID Result Requirement

Require skill packet or worker packet IDs in result artifacts.

Closeout labels missing packet IDs as manual/unsealed.

### Phase 3: Polaris Commit Command

Add packet-authorized commit/finalize command.

### Phase 4: Optional Git Hooks

Add local hook support for warning or blocking unauthorized commits.

### Phase 5: GitHub PR Integration

Polaris creates or verifies PRs using packet/run metadata.

## Current Recommendation

Start simple:

1. Generate packet IDs.
2. Require packet IDs in closeout/finalize.
3. Mark work without packet IDs as manual/unsealed.
4. Delay hard commit blocking until the workflow is stable.
