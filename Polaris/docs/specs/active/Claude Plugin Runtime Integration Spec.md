---
title: Claude Plugin Runtime Integration Spec
status: raw
source: conversation
intended_path: docs/specs/raw/claude-plugin-runtime-integration.md
owner: Polaris
mode: plan-source
---
Claude Plugin Runtime Integration Spec

Purpose

Create the minimum working Claude plugin integration for Polaris.

This spec exists so polaris-plan can convert a spec file into runnable implementation steps. This is not an existing tracker cluster and should not be handled as an analyze-from-issue workflow.

The goal is to prove that Claude can load a Polaris plugin from the repository and use it to invoke the local Polaris runtime without reimplementing the loop inside Claude-specific instructions.

Core Hypothesis

Polaris should become an installable local runtime that agent plugins can invoke.

The Claude plugin should act as a thin integration layer:

Claude plugin / skill surface
→ local Polaris CLI or repo-local script
→ Polaris runtime owns loop/state/telemetry/adapters
→ worker executes one child/task
→ durable state updates
→ compact result returns

The plugin should not own the loop. Polaris owns the loop.

Primary Objective

Build a minimum working Claude plugin for Polaris that can:

1. Be installed or loaded by Claude from the Polaris repository.
2. Expose Polaris-oriented commands or skills.
3. Invoke the local Polaris runtime through a CLI or repo-local fallback.
4. Prove command invocation with a safe status or dry-run command.
5. Preserve existing Polaris runtime semantics.

Non-Goals

This spec does not attempt to:

* build Codex plugin support
* build Gemini / Antigravity support
* build Windsurf integration
* build full provider rotation
* replace Polaris runtime logic with Claude-specific plugin logic
* make Claude the only supported provider
* solve all plugin marketplace publishing requirements
* implement Connect/Alice runtime integration

Those belong in follow-up specs/issues.

Required Plugin Behavior

The plugin should expose or route the following minimum capabilities:

1. Polaris Status

A command or skill that can report local Polaris runtime status.

Expected behavior:

Claude → Polaris plugin → polaris status or repo-local equivalent

The status command should be safe and read-only.

It should verify that the plugin can invoke local Polaris runtime code.

2. Polaris Run

A command or skill that can start a Polaris run from a parent source.

Example target shape:

polaris run POL-42
polaris run docs/specs/raw/claude-plugin-runtime-integration.md

For the first implementation, this may be documented or wired in dry-run mode only if full run execution is unsafe or blocked.

3. Polaris Loop Continue

A command or skill that can continue an existing Polaris loop from durable state.

Example target shape:

polaris loop continue --state-file .taskchain_artifacts/polaris-run/current-state.json

The plugin must not manually mutate loop state. It should call Polaris runtime commands.

4. Dry-Run / Smoke Test

The plugin must support a safe proof path.

Acceptable smoke tests:

* polaris status
* polaris run <source> --dry-run
* polaris loop continue --dry-run
* repo-local equivalent if polaris binary is not yet installed

Runtime Invocation Strategy

The plugin should prefer an installed Polaris CLI if available:

polaris status
polaris run <source>
polaris loop continue

If Polaris is not yet packaged as an installed CLI, the plugin may temporarily use repo-local commands:

node dist/cli/index.js status
node dist/cli/index.js loop continue
scripts/polaris-run.sh <issue-or-source>

This fallback must be clearly marked temporary.

Long-term, Polaris must expose a real package/CLI command.

Package/CLI Requirement

The plugin should not depend forever on repo-local internals.

This spec should identify the minimum packaging work required for:

polaris status
polaris run <source>
polaris loop continue
polaris finalize

Required packaging questions:

1. Does package.json expose a bin entry for polaris?
2. Does the built CLI include a shebang and executable output?
3. Can users run Polaris through npm link during development?
4. Can users run Polaris through npm install -D or npx later?
5. How should the plugin discover the local Polaris command?
6. What should happen if the binary is missing?

Claude Plugin Unknowns

The implementation must verify the current Claude plugin requirements rather than guessing.

Unknowns to verify:

1. Required plugin manifest path and schema.
2. Whether Claude Desktop plugins can invoke local commands directly.
3. Whether Claude Code plugins and Claude Desktop plugins share the same manifest model.
4. Whether local command execution requires MCP, hooks, tools, or another bridge.
5. Whether plugin installation from repo URL loads only skills/instructions or can expose executable tools.
6. What permission or trust prompts are required.
7. Whether a plugin can safely call repo-local scripts.
8. How plugin commands are surfaced to the user.

If local command execution is blocked, document the exact blocker and propose the smallest bridge, likely MCP/local tool wrapper.

Expected Files / Areas to Inspect

The implementation run should inspect current repo structure before deciding exact paths.

Likely areas:

* package.json
* src/cli/
* dist/cli/
* scripts/polaris-run.sh
* .claude/
* .codex/skills/
* .taskchain_artifacts/
* docs/spec/
* docs/specs/
* docs/runtime/
* existing Polaris skill/taskchain files

Potential new areas:

* .claude-plugin/
* .claude/skills/
* plugins/claude/
* docs/integrations/claude-plugin.md
* docs/runtime/plugin-smoke-tests/

Exact location should follow current Claude plugin requirements and repo conventions discovered during implementation.

Runtime Architecture Rules

Polaris Owns the Loop

The Claude plugin must not implement loop logic itself.

It may expose command entrypoints, but current-state, telemetry, bootstrap packets, provider selection, continuation policy, and finalization remain Polaris runtime responsibilities.

Plugin Is Thin

The plugin should:

* expose commands/skills
* call local Polaris runtime
* return compact results
* surface blockers clearly

The plugin should not:

* parse and mutate current-state manually
* run child implementation inline
* bypass Polaris adapters
* hardcode Claude as the only provider
* duplicate Polaris run semantics

State Is Durable

All execution continuity must flow through durable artifacts:

* .taskchain_artifacts/.../current-state.json
* telemetry JSONL
* bootstrap packets
* commits
* docs/runtime artifacts
* tracker state where applicable

Chat context must not be treated as execution memory.

Worker Boundary Remains Intact

If the plugin starts a run, workers still execute one child/task at a time.

The plugin should not encourage long inline implementation sessions.

Compact Runtime Behavior

The plugin should align with Polaris compact runtime policy.

Orchestrator-facing output may report progress:

{
  "status": "ready",
  "runtime": "polaris",
  "source": "docs/specs/raw/claude-plugin-runtime-integration.md",
  "next": "plan"
}

Worker-facing output must remain strict and minimal:

{
  "child_id": "POL-XX",
  "status": "done",
  "commit": "abc1234",
  "validation": "passed",
  "state_updated": true,
  "telemetry_updated": true
}

Detailed logs should persist to artifacts, not parent chat.

Safety Requirements

The plugin must not silently execute destructive operations.

Safe by default:

* status checks
* dry-runs
* reading current-state
* reading telemetry summaries
* generating plugin manifest/docs

Require explicit confirmation or existing trusted runtime policy for:

* git push
* force push
* branch deletion
* destructive file deletion
* production deploys
* secret access
* irreversible state changes

The plugin should respect existing Polaris/agent permission boundaries.

Validation Requirements

Minimum validation for this spec:

1. Plugin files exist in the expected location.
2. Plugin manifest validates against current Claude requirements or documented equivalent.
3. Claude install/load path is documented.
4. Local Polaris command invocation is proven or blocker is documented.
5. Smoke test command runs safely.
6. Existing Polaris tests still pass.
7. Existing repo-local skills are not broken.
8. No Claude-only provider lock-in is introduced.

Suggested commands, adjusted to actual repo state:

npm test
npm run build
npm run lint
polaris status
polaris loop continue --dry-run

If polaris binary is not available yet:

node dist/cli/index.js status
node dist/cli/index.js loop continue --dry-run

Success Criteria

This spec succeeds when:

* Polaris has a minimum Claude plugin scaffold.
* The plugin can be installed or loaded from the repo, or a precise blocker is documented.
* The plugin can invoke local Polaris runtime directly, or a precise MCP/local-tool bridge requirement is documented.
* A safe status or dry-run command proves the invocation path.
* The plugin remains thin and does not duplicate Polaris runtime logic.
* Polaris runtime remains provider-neutral.
* Existing skills and loop behavior continue to work.
* The result can be used as the foundation for finishing EVO with Claude-assisted Polaris runs.

Plan Input Expectations

polaris-plan should consume this spec and produce runnable implementation tasks.

Expected task categories:

1. Verify Claude plugin requirements.
2. Audit current Polaris CLI/package surface.
3. Add or fix local polaris CLI entrypoint if needed.
4. Add minimum Claude plugin scaffold.
5. Wire plugin command(s) to local Polaris runtime.
6. Add smoke test / verification docs.
7. Validate existing loop behavior remains intact.
8. Document blockers and follow-up work.

Generated tasks should be executable one at a time through Polaris-run.

Open Questions

1. Does Claude Desktop plugin execution allow local command invocation directly?
2. Does Claude Code plugin execution differ from Claude Desktop plugin execution?
3. Is MCP required for local command invocation?
4. Should Polaris maintain separate Claude Desktop and Claude Code plugin packages?
5. Should plugin commands invoke polaris binary only, or allow repo-local fallback during development?
6. How should plugin trust/permission setup be documented?
7. Should the first plugin command be status only to minimize risk?
8. Should polaris init eventually generate plugin config automatically?

Recommended First Slice

Build the smallest proof first:

Claude plugin installed/loaded
→ command invokes Polaris status/dry-run
→ output confirms current repo/runtime state

Do not start with full autonomous run execution.

Full run execution should come after status/dry-run invocation is proven.