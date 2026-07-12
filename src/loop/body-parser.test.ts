import { describe, expect, it } from "vitest";
import { parseIssueBody, validateCanonicalSections } from "./body-parser.js";

const BODY_WITH_SCOPE = `## Goal
Add a hard gate in the packet generator that refuses to emit an \`impl\` packet.

## Scope
Touch only:
- \`src/loop/\` — packet generation and dispatch path
- \`src/cli/\` — dispatch CLI command if gate belongs there

## Acceptance Criteria
- allowed_scope is empty ([])
- primary_goal is a placeholder

## Validation
- npm test -- --grep "packet.*empty.*scope"
- npm run build
`;

const BODY_WITH_EXPECTED_CODE_AREAS = `## Goal
Fix the parser.

## Expected code areas
- \`src/loop/worker-packet.ts\`
- \`src/loop/dispatch.ts\`

## Validation
- npm test
`;

const BODY_NO_SCOPE = `## Goal
Fix something.

## Acceptance Criteria
- Tests pass
`;

// ── parseIssueBody: scope extraction ─────────────────────────────────────────

describe("parseIssueBody — scope", () => {
  it("extracts list items from ## Scope section", () => {
    const { scope } = parseIssueBody(BODY_WITH_SCOPE);
    expect(scope).toHaveLength(2);
    expect(scope[0]).toContain("src/loop/");
    expect(scope[1]).toContain("src/cli/");
  });

  it("extracts list items from ## Expected code areas section", () => {
    const { scope } = parseIssueBody(BODY_WITH_EXPECTED_CODE_AREAS);
    expect(scope).toHaveLength(2);
    expect(scope[0]).toContain("src/loop/worker-packet.ts");
    expect(scope[1]).toContain("src/loop/dispatch.ts");
  });

  it("returns empty scope when no scope section is present", () => {
    const { scope } = parseIssueBody(BODY_NO_SCOPE);
    expect(scope).toEqual([]);
  });

  it("returns empty scope for empty body", () => {
    const { scope } = parseIssueBody("");
    expect(scope).toEqual([]);
  });

  it("returns empty scope for whitespace-only body", () => {
    const { scope } = parseIssueBody("   \n  \n  ");
    expect(scope).toEqual([]);
  });

  it("strips trailing prose and preserves bare file/glob patterns", () => {
    const body = `## Scope
- src/foo.ts some comment
- .polaris/runs/**/run-report.md fixtures if tests use fixtures
- src/bar.ts (new)
`;
    const { scope } = parseIssueBody(body);
    expect(scope).toEqual([
      "src/foo.ts",
      ".polaris/runs/**/run-report.md",
      "src/bar.ts",
    ]);
  });
});

// ── parseIssueBody: validationCommands ───────────────────────────────────────

describe("parseIssueBody — validationCommands", () => {
  it("extracts commands from ## Validation section", () => {
    const { validationCommands } = parseIssueBody(BODY_WITH_SCOPE);
    expect(validationCommands).toHaveLength(2);
    expect(validationCommands[0]).toContain("npm test");
    expect(validationCommands[1]).toBe("npm run build");
  });

  it("returns empty validationCommands when no validation section exists", () => {
    const { validationCommands } = parseIssueBody(BODY_NO_SCOPE);
    expect(validationCommands).toEqual([]);
  });
});

// ── parseIssueBody: requirements ─────────────────────────────────────────────

describe("parseIssueBody — requirements", () => {
  it("extracts items from ## Acceptance Criteria section", () => {
    const { requirements } = parseIssueBody(BODY_WITH_SCOPE);
    expect(requirements).toHaveLength(2);
    expect(requirements[0]).toContain("allowed_scope");
    expect(requirements[1]).toContain("primary_goal");
  });

  it("returns empty requirements when no acceptance criteria section exists", () => {
    const { requirements } = parseIssueBody(BODY_WITH_EXPECTED_CODE_AREAS);
    expect(requirements).toEqual([]);
  });
});

// ── Scope inheritance precedence ──────────────────────────────────────────────
//
// These tests exercise the precedence rules documented in body-parser.ts:
//   1. Explicit allowedScope (caller override) — tested in worker-packet.test.ts
//   2. Child body scope — takes priority over parent
//   3. Parent body scope — fallback only when child has no scope section
//   4. Both absent — empty (preflight gate fires upstream)

const CHILD_BODY_WITH_SCOPE = `## Goal
Implement the child fix.

## Scope
- src/loop/worker-packet.ts
- src/loop/dispatch.ts

## Validation
- npm test
`;

const CHILD_BODY_WITHOUT_SCOPE = `## Goal
Implement the child fix.

## Acceptance Criteria
- Tests pass
`;

const PARENT_BODY_WITH_SCOPE = `## Goal
Parent implementation plan.

## Scope
- src/loop/**
- src/finalize/**
- tests/**
`;

describe("scope inheritance precedence", () => {
  it("child body scope is returned directly when it has a ## Scope section", () => {
    const { scope } = parseIssueBody(CHILD_BODY_WITH_SCOPE);
    expect(scope).toEqual([
      "src/loop/worker-packet.ts",
      "src/loop/dispatch.ts",
    ]);
  });

  it("child body scope does not include parent scope (no merging)", () => {
    const childScope = parseIssueBody(CHILD_BODY_WITH_SCOPE).scope;
    const parentScope = parseIssueBody(PARENT_BODY_WITH_SCOPE).scope;
    // Child scope is authoritative — parent scope items must not appear
    for (const item of parentScope) {
      expect(childScope).not.toContain(item);
    }
  });

  it("parent body scope is returned when child body has no scope section", () => {
    const { scope: childScope } = parseIssueBody(CHILD_BODY_WITHOUT_SCOPE);
    expect(childScope).toEqual([]); // child has no scope

    const { scope: parentScope } = parseIssueBody(PARENT_BODY_WITH_SCOPE);
    expect(parentScope).toEqual(["src/loop/**", "src/finalize/**", "tests/**"]);
    // Caller's fallback: use parentScope when childScope is empty
    const resolved = childScope.length > 0 ? childScope : parentScope;
    expect(resolved).toEqual(parentScope);
  });

  it("child scope overrides parent scope — different items, child wins", () => {
    const childScope = parseIssueBody(CHILD_BODY_WITH_SCOPE).scope;
    const parentScope = parseIssueBody(PARENT_BODY_WITH_SCOPE).scope;
    // Caller's precedence: child is non-empty, so parent is never consulted
    const resolved = childScope.length > 0 ? childScope : parentScope;
    expect(resolved).toEqual(childScope);
    expect(resolved).not.toEqual(parentScope);
  });

  it("both absent → empty scope (signals preflight gate must fire)", () => {
    const { scope: childScope } = parseIssueBody(CHILD_BODY_WITHOUT_SCOPE);
    const { scope: parentScope } = parseIssueBody("## Goal\nDo something.\n");
    const resolved = childScope.length > 0 ? childScope : parentScope;
    expect(resolved).toEqual([]);
  });
});

// ── Canonical issue template — all 8 required sections ───────────────────────
//
// These tests verify that parseIssueBody correctly extracts all 8 sections
// from a fully-formed canonical implementation issue body, and that
// validateCanonicalSections correctly identifies missing sections.

const CANONICAL_CHILD_BODY = `## Objective
Add a hard gate in the packet generator that refuses to emit an impl packet when allowed_scope is empty.

## Context
Recent Polaris runs produced fake completions because workers received empty allowed_scope. The scope gate was added to the runtime but analyst-created issues still lacked machine-readable scope sections, defeating the gate.

## Goal
Every impl child issue carries a parseable ## Scope list so the runtime can always derive a non-empty allowed_scope before dispatch.

## Scope
- src/loop/**
- src/finalize/**
- src/cluster-state/**
- src/loop/parent.test.ts

## Acceptance Criteria
- allowed_scope is non-empty for all impl children
- preflight gate fires when scope is missing
- Tests pass for all new and existing scope paths

## Validation
- npm run build
- npm test
- npx vitest run src/loop src/finalize src/cluster-state

## Ordering
- Depends on POL-100 (runtime gate) being merged first

## Non-goals
- Do not modify the Linear API adapter
- Do not change tracker schema
`;

describe("parseIssueBody — canonical sections", () => {
  it("extracts Objective as prose text", () => {
    const { objective } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(objective).toContain("hard gate");
    expect(objective.length).toBeGreaterThan(0);
  });

  it("extracts Context as prose text", () => {
    const { context } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(context).toContain("fake completions");
    expect(context.length).toBeGreaterThan(0);
  });

  it("extracts Goal as prose text", () => {
    const { goal } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(goal).toContain("parseable");
    expect(goal.length).toBeGreaterThan(0);
  });

  it("extracts Scope as list items", () => {
    const { scope } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(scope).toHaveLength(4);
    expect(scope).toContain("src/loop/**");
    expect(scope).toContain("src/finalize/**");
    expect(scope).toContain("src/cluster-state/**");
    expect(scope).toContain("src/loop/parent.test.ts");
  });

  it("extracts Acceptance Criteria as list items", () => {
    const { requirements } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(requirements.length).toBeGreaterThan(0);
    expect(requirements[0]).toContain("allowed_scope");
  });

  it("extracts Validation commands as list items", () => {
    const { validationCommands } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(validationCommands).toHaveLength(3);
    expect(validationCommands[0]).toBe("npm run build");
    expect(validationCommands[1]).toBe("npm test");
    expect(validationCommands[2]).toContain("npx vitest");
  });

  it("extracts Ordering as list items", () => {
    const { ordering } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(ordering.length).toBeGreaterThan(0);
    expect(ordering[0]).toContain("POL-100");
  });

  it("extracts Non-goals as list items", () => {
    const { nonGoals } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(nonGoals).toHaveLength(2);
    expect(nonGoals[0]).toContain("Linear API adapter");
    expect(nonGoals[1]).toContain("tracker schema");
  });

  it("scopeBlocked is false for valid scope entries", () => {
    const { scopeBlocked } = parseIssueBody(CANONICAL_CHILD_BODY);
    expect(scopeBlocked).toBe(false);
  });
});

// ── TBD-BLOCKED scope detection ───────────────────────────────────────────────

const BODY_WITH_TBD_SCOPE = `## Objective
Do something.

## Context
Unknown yet.

## Goal
TBD.

## Scope
- TBD — BLOCKED: scope missing

## Acceptance Criteria
- TBD

## Validation
- npm test

## Ordering
- None

## Non-goals
- None
`;

const BODY_WITH_MIXED_TBD_SCOPE = `## Scope
- TBD — BLOCKED: scope missing
- src/loop/dispatch.ts
`;

describe("parseIssueBody — TBD-blocked scope", () => {
  it("treats all-TBD scope as empty and sets scopeBlocked: true", () => {
    const { scope, scopeBlocked } = parseIssueBody(BODY_WITH_TBD_SCOPE);
    expect(scope).toEqual([]);
    expect(scopeBlocked).toBe(true);
  });

  it("does not block scope when TBD item is mixed with real paths", () => {
    const { scope, scopeBlocked } = parseIssueBody(BODY_WITH_MIXED_TBD_SCOPE);
    // Mixed: the TBD item is filtered out but a real path is present
    expect(scopeBlocked).toBe(false);
    expect(scope).toContain("src/loop/dispatch.ts");
    expect(scope).not.toContain("TBD — BLOCKED: scope missing");
  });

  it("scopeBlocked: false for normal bodies without scope section", () => {
    const { scopeBlocked } = parseIssueBody(BODY_NO_SCOPE);
    expect(scopeBlocked).toBe(false);
  });

  it("scopeBlocked: false for empty body", () => {
    const { scopeBlocked } = parseIssueBody("");
    expect(scopeBlocked).toBe(false);
  });
});

// ── validateCanonicalSections ─────────────────────────────────────────────────

describe("validateCanonicalSections", () => {
  it("returns empty array when all 8 canonical sections are present", () => {
    const missing = validateCanonicalSections(CANONICAL_CHILD_BODY);
    expect(missing).toEqual([]);
  });

  it("returns all 8 section names for an empty body", () => {
    const missing = validateCanonicalSections("");
    expect(missing).toHaveLength(8);
  });

  it("returns all 8 section names for a whitespace-only body", () => {
    const missing = validateCanonicalSections("   \n  \n  ");
    expect(missing).toHaveLength(8);
  });

  it("reports missing Scope when section is absent", () => {
    const body = CANONICAL_CHILD_BODY.replace(/## Scope[\s\S]*?## Acceptance/, "## Acceptance");
    const missing = validateCanonicalSections(body);
    expect(missing).toContain("Scope");
  });

  it("reports missing Validation when section is absent", () => {
    const body = CANONICAL_CHILD_BODY.replace(/## Validation[\s\S]*?## Ordering/, "## Ordering");
    const missing = validateCanonicalSections(body);
    expect(missing).toContain("Validation");
  });

  it("reports missing Objective when section is absent", () => {
    const body = CANONICAL_CHILD_BODY.replace(/## Objective[\s\S]*?## Context/, "## Context");
    const missing = validateCanonicalSections(body);
    expect(missing).toContain("Objective");
  });

  it("reports missing Context when section is absent", () => {
    const body = CANONICAL_CHILD_BODY.replace(/## Context[\s\S]*?## Goal/, "## Goal");
    const missing = validateCanonicalSections(body);
    expect(missing).toContain("Context");
  });

  it("reports missing Ordering when section is absent", () => {
    const body = CANONICAL_CHILD_BODY.replace(/## Ordering[\s\S]*?## Non-goals/, "## Non-goals");
    const missing = validateCanonicalSections(body);
    expect(missing).toContain("Ordering");
  });

  it("reports missing Non-goals when section is absent", () => {
    const body = CANONICAL_CHILD_BODY.replace(/\n## Non-goals[\s\S]*$/, "\n");
    const missing = validateCanonicalSections(body);
    expect(missing).toContain("Non-goals");
  });

  it("accepts ## Expected code areas as alias for Scope", () => {
    const body = CANONICAL_CHILD_BODY.replace("## Scope", "## Expected code areas");
    const missing = validateCanonicalSections(body);
    expect(missing).not.toContain("Scope");
  });

  it("returns only the sections that are actually missing", () => {
    const missing = validateCanonicalSections(BODY_NO_SCOPE);
    // BODY_NO_SCOPE has Goal and Acceptance Criteria but no Scope, Validation, etc.
    expect(missing).toContain("Scope");
    expect(missing).toContain("Validation");
    expect(missing).toContain("Objective");
    expect(missing).not.toContain("Acceptance Criteria");
  });
});
