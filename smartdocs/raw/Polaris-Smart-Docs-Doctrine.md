# Polaris Smart Docs Doctrine

## Purpose

Smart Docs are Polaris-owned doctrine documents designed to keep agents, implementation work, runtime behavior, and repository structure aligned.

A Smart Doc is not just a markdown file.

A Smart Doc is a routable, implementation-aware doctrine surface that tells agents how a system is supposed to work, which local repo surfaces it governs, and how to detect drift between intended architecture and actual code.

---

## Core Definition

A Smart Doc answers:

> How is this system supposed to work?

A `POLARIS.md` file answers:

> What is here?

Together, they create the Polaris documentation cognition layer:

```text
Smart Docs
  → how things are supposed to work

POLARIS.docs.md
  → local summary/router for relevant Smart Docs

POLARIS.md
  → what lives in this folder and how to navigate it

Implementation files
  → actual system behavior
```

---

## Smart Doc Requirements

A Smart Doc must be:

- purpose-scoped
- routable
- implementation-aware
- linked to relevant local surfaces
- safe for agent context loading
- canonical or explicitly transitional
- separate from logs and runtime artifacts

A Smart Doc should define:

- governed concepts
- expected behavior
- relevant file/folder surfaces
- related `POLARIS.md` files
- related `POLARIS.docs.md` summaries
- known risks
- drift/conflict handling rules

---

## Smart Docs vs POLARIS.md

### `POLARIS.md`

A `POLARIS.md` file is local.

It tells the agent:

- what files live here
- what this folder owns
- what entry points exist
- what tests matter
- what nearby files are dangerous
- what local rules apply

It is a local navigation map.

---

### Smart Docs

A Smart Doc is canonical doctrine.

It tells the agent:

- how this system is supposed to work
- what behavior is expected
- what contracts must be preserved
- what architecture governs this surface
- when implementation has drifted from doctrine

It is the governing “how it should work” layer.

---

### `POLARIS.docs.md`

A `POLARIS.docs.md` file is a local doctrine router.

It sits beside a `POLARIS.md` file and summarizes the Smart Docs relevant to that folder.

It should include:

- relevant Smart Docs
- short local doctrine summary
- known conflicts
- stale/deprecated docs
- implementation surfaces governed by those docs
- links back to canonical docs

It must not become the doctrine itself.

---

## Three-Layer Model

```text
Canonical Smart Docs
        ↓
Localized POLARIS.docs.md summaries
        ↓
Folder-level POLARIS.md maps
        ↓
Implementation files
```

Agents should use this flow:

1. Read relevant Smart Docs.
2. Follow links to local `POLARIS.docs.md`.
3. Read nearby `POLARIS.md`.
4. Inspect implementation.
5. Compare actual code against doctrine.
6. Implement, correct docs, or report conflict.

---

## LLM Wiki Philosophy

Smart Docs use an LLM wiki philosophy.

That means docs are not only stored; they are structured for agent traversal.

Smart Docs should support:

- graph-style linking
- backlinks
- domain routing
- local summaries
- implementation mapping
- context compression
- doctrine conflict detection

The goal is not just human readability.

The goal is agent-usable cognition.