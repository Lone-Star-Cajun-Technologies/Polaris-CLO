# .polaris/skills/closeout-librarian/

## Purpose

This directory contains the Closeout Librarian skill package.

The Closeout Librarian is a bounded runtime role dispatched by the Foreman exactly once
per completed cluster, after all children are done and before PR creation.

## Contents

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill entry point — read first, contains bootloader instructions and packet schema reference |
| `chain.md` | Step-order execution map — the Librarian executes this in strict step order |
| `steps/01-load-cluster-context.md` | Build work inventory from packet and cluster evidence |
| `steps/02-reconcile-polaris-md.md` | Update affected POLARIS.md files |
| `steps/03-reconcile-summary-md.md` | Refresh SUMMARY.md as continuation artifact |
| `steps/04-doc-ingestion.md` | Ingest/promote/archive documentation |
| `steps/05-link-validation.md` | Validate and repair broken links |
| `steps/06-yaml-linking.md` | Update YAML references for promoted documents |
| `steps/07-librarian-commit.md` | Commit documentation changes |
| `steps/08-sealed-result.md` | Write sealed result JSON and terminate |

## Invocation

This skill is NOT invoked by user command. It is dispatched by the Foreman during
step 08 of the `polaris-run` chain after cluster-complete is confirmed.

The Foreman generates the packet via:
```bash
polaris librarian packet <cluster-id>
```

Then dispatches the Librarian as a bounded subagent session.

## Authority

The Closeout Librarian may update POLARIS.md, SUMMARY.md, ingest documents, and commit
documentation changes. It may NOT modify source code, runtime state, or create PRs.

Full authority boundaries: `.polaris/roles/closeout-librarian.md`

## Spec Reference

`smartdocs/specs/active/closeout-librarian-spec.md`
