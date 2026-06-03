# `.polaris/cognition/` — Staging Root Contract

This folder is the runtime staging root for folder-local cognition reconciliation.

- `pending/` contains ephemeral worker-written staging notes awaiting reconciliation.
- `archive/` contains durable reconciled-note provenance and per-folder indexes.

## Worker Contract

- Workers write one completion note per child into `pending/<folder-slug>/`.
- Notes are staging artifacts for librarian reconciliation, not canonical cognition.
- Workers do not write canonical folder cognition here.

## Cognition Librarian Contract

- Librarian reads assigned `pending/<folder-slug>/` notes and target folder cognition files.
- Librarian proposes updates via a sealed result contract; it never writes canonical files directly.
- Foreman validates and applies accepted proposals, then archives reconciled notes.

## Tracking and Durability

- `pending/` is ephemeral runtime state and must remain gitignored.
- `archive/` is durable provenance and must remain tracked.
