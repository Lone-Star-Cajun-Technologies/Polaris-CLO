# Polaris — AGENTS.md

## Agent posture

Implement only when explicitly assigned implementation work. Read and plan freely; do not write code unless the current child issue requires it.

## Cluster execution rules

- Only the current lowest-numbered open child issue may execute at any time.
- Do not execute a higher-numbered child while a lower-numbered sibling is open.
- Do not execute children from a different parent cluster in the same session.

## Scope discipline

Adjacent discoveries during execution → open a follow-up Linear issue. Do not silently expand scope.

## Analyze/implement boundary

Analyze-type children (research, spec, comparison) must not auto-continue into implementation children. Stop after the analyze child is Done and await explicit instruction.

## Blocker protocol

If a blocker is found at any step: halt immediately and report the blocker with an explicit unblock condition. Do not work around blockers silently. Do not advance to the next child.
