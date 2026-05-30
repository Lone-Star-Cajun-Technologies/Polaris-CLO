# smartdocs/docs

## Purpose

`smartdocs/docs/` is the canonical SmartDocs content root. Stable documentation domains live here; runtime-generated content does not.

## What belongs here

- Stable documentation domains such as `architecture/`, `doctrine/`, `specs/`, `integrations/`, `audits/`, and `decisions/`
- Ingest staging content in `raw/`
- Route-local cognition surfaces for canonical folders

## What does not belong here

- Generated runtime output in `runtime/`
- Hidden vault config
- Canonical content outside the SmartDocs tree

## Editing rules

- Keep this directory as the ingest target and canonical content root.
- Prefer folder-local cognition files in subdirectories.
- Exclude generated runtime surfaces from cognition updates.
