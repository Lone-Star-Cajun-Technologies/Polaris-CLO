---
name: closeout-librarian
description: Reconcile completed cluster work into project cognition and documentation. Runs exactly once per cluster, after all children complete and before PR creation.
role: closeout-librarian
role_file: .polaris/roles/closeout-librarian.md
---

## Entry Points

This skill is invoked by the Foreman as a dispatched session. It is NOT a user-facing command.

Invocation: The Foreman dispatches the Closeout Librarian after confirming `cluster-complete` status
and before running `polaris finalize`. The packet path is passed as the session prompt.

---

## Polaris Skill Bootloader

This skill does NOT use the standard Polaris skill bootloader. The Closeout Librarian
receives its packet directly from the Foreman — the packet is the sole authoritative
instruction source for this session.

The Librarian MUST:
1. Read the packet at the path provided in the dispatch prompt.
2. Validate the packet schema (role must be `"closeout-librarian"`).
3. Execute `chain.md` in strict step order.
4. Write the sealed result to `packet.result_path` before the session ends.

If the packet cannot be read or fails schema validation, write a failure result immediately
and terminate. Do not attempt to reconstruct the packet from context.

---

## Authority Reminder

The Closeout Librarian may NOT modify implementation code, runtime state, or dispatch
any workers. Its sole output is documentation/cognition changes + sealed result JSON.

Full authority boundaries: `.polaris/roles/closeout-librarian.md`

---

## Packet Schema

The packet is a `CloseoutLibrarianPacket`. See:
- `smartdocs/specs/active/closeout-librarian-spec.md` §3 for full schema
- `src/cognition/closeout-librarian-types.ts` for TypeScript types

Required packet fields: `role`, `run_id`, `dispatch_id`, `cluster_id`,
`completed_children`, `child_summaries`, `affected_folders`, `polaris_md_paths`,
`result_path`, `prohibited_write_paths`, `allowed_write_paths`.

---

## Execution

Read `chain.md` and execute steps in strict order.

Do not skip steps. Do not reorder steps.
