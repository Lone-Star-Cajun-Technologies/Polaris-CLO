# Caveman — Optional External Provider Doctrine

## Default baseline

Polaris-native compact orchestration is the authoritative default. Caveman is not required and must not be assumed present.

## Detection is not activation

The presence of a Caveman configuration, binary, or linked skill does **not** activate Caveman for a run. Detection is not activation.

Caveman must be **explicitly enabled** for the current run via config or a direct invocation flag. If it has not been explicitly enabled, use Polaris-native compact exclusively.

## When Caveman may be used

Only activate Caveman if:

1. The run configuration explicitly enables it, **and**
2. The task requires a capability not available in Polaris-native compact.

Do not activate Caveman as a fallback for convenience or because it was used in a previous session.

## Caveman as external provider

If activated, Caveman acts as an external provider for analysis tasks. It does not replace Polaris runtime authority. Polaris runtime state remains authoritative. Caveman-emitted analysis results must be validated as compact results before being accepted by the parent.

## What Caveman is not

- Not a default analysis orchestration layer
- Not a dependency for Polaris-native analyze runs
- Not a substitute for querying Polaris runtime state
