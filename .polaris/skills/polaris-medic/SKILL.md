---
name: polaris-medic
description: Diagnose and repair failed worker executions, create medical charts, and prepare for Librarian reconciliation.
role: medic
role_file: .polaris/roles/medic.md
---

## Entry Points

This skill is invoked by the Foreman as a dispatched session when a worker returns a failed result packet.

Invocation: The Foreman dispatches Medic after detecting a failed result packet and marking triage required. The packet path is passed as the session prompt.

---

## Polaris Skill Bootloader

This skill does NOT use the standard Polaris skill bootloader. The Medic receives its packet directly from the Foreman — the packet is the sole authoritative instruction source for this session.

The Medic MUST:
1. Read the packet at the path provided in the dispatch prompt.
2. Validate the packet schema (role must be `"medic"`).
3. Execute `chain.md` in strict step order.
4. Write the sealed result to `packet.result_path` before the session ends.

If the packet cannot be read or fails schema validation, write a failure result immediately and terminate. Do not attempt to reconstruct the packet from context.

---

## Authority Reminder

The Medic may modify implementation code to repair failures. The Medic may create charts in `smartdocs/medic/charts/`. The Medic does NOT modify runtime state, dispatch workers, or perform normal implementation work.

Full authority boundaries: `.polaris/roles/medic.md`

---

## Packet Schema

The packet is a `MedicPacket`. See:
- `src/types/result-packet.ts` for TypeScript types
- This packet includes the failed worker result packet and cluster context

Required packet fields: `role`, `run_id`, `dispatch_id`, `cluster_id`, `failed_result_packet`, `cluster_context`, `result_path`, `allowed_write_paths`, `prohibited_write_paths`.

---

## Execution

Read `chain.md` and execute steps in strict order.

Do not skip steps. Do not reorder steps.