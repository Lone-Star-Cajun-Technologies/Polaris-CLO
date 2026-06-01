import { describe, expect, it } from "vitest";
import { parseIssueBody } from "./body-parser.js";

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
