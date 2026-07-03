/**
 * Issue body section parser.
 *
 * Parses a markdown issue body into structured fields used by the packet
 * generator. Sections are identified by `## Header` lines (case-insensitive).
 * List items are lines starting with `- ` or `* `.
 *
 * ## Canonical section format
 *
 * All implementation issues (parents and children) must use this exact format:
 *
 *   ## Objective          — one-sentence statement of what this issue accomplishes
 *   ## Context            — why this issue exists
 *   ## Goal               — specific implementation outcome
 *   ## Scope              — machine-readable list of allowed paths/globs (REQUIRED)
 *   ## Acceptance Criteria — checklist of observable completion requirements
 *   ## Validation         — commands that must be run (REQUIRED)
 *   ## Ordering           — dependencies or sequencing relative to siblings
 *   ## Non-goals          — what this issue must not change
 *
 * Use `## Scope` exactly — not "Implementation scope", "Expected code areas",
 * or other variants. Aliases are supported for backward compatibility only.
 *
 * If scope cannot be determined, write:
 *   ## Scope
 *   - TBD — BLOCKED: scope missing
 * and mark the Linear issue as Blocked. Do NOT invent paths.
 *
 * ## Scope inheritance precedence
 *
 * When `buildPacket` resolves `allowed_scope` for a worker packet, it applies
 * the following rules in order (first non-empty result wins):
 *
 *   1. Explicit `allowedScope` passed to `compileImplPacket` by the caller.
 *   2. Child issue body `## Scope` section.
 *   3. Cluster-root (parent) body `## Scope` section — fallback only when the
 *      child body has no scope section at all.
 *   4. Empty or TBD-blocked → preflight gate halts dispatch with
 *      `preflight-scope-missing`.
 *
 * Rule 3 means a parent implementation plan can declare a cluster-wide scope
 * that all child issues inherit when they omit their own scope section.
 * A child that DOES declare its own scope section always overrides the parent —
 * the parent scope is never merged with or appended to the child scope.
 *
 * Analyze children are exempt from scope preflight (they don't produce impl
 * packets and don't need code-area constraints).
 */

export interface ParsedIssueBody {
  scope: string[];
  /** True when scope section contains only TBD-BLOCKED markers (treated as empty). */
  scopeBlocked: boolean;
  validationCommands: string[];
  requirements: string[];
  objective: string;
  context: string;
  goal: string;
  ordering: string[];
  nonGoals: string[];
}

/**
 * Canonical scope header. Aliases kept for backward compatibility only.
 * New issues must use `## Scope` exactly.
 */
const SCOPE_HEADERS = new Set([
  'scope',
  'expected code areas',
  'code areas',
  'files to change',
  'files',
]);

const VALIDATION_HEADERS = new Set([
  'validation',
  'validation commands',
  'test commands',
  'verify',
]);

const REQUIREMENTS_HEADERS = new Set([
  'acceptance criteria',
  'requirements',
  'criteria',
]);

const ORDERING_HEADERS = new Set([
  'ordering',
  'dependencies / blockers',
  'dependencies',
  'order',
]);

const NON_GOALS_HEADERS = new Set([
  'non-goals',
  'non goals',
  'out of scope',
]);

const OBJECTIVE_HEADERS = new Set(['objective']);
const CONTEXT_HEADERS = new Set(['context']);
const GOAL_HEADERS = new Set(['goal', 'goals']);

/** Pattern that identifies a TBD-BLOCKED scope marker. */
const TBD_BLOCKED_RE = /^tbd\b/i;

/**
 * Canonical sections required on every implementation issue.
 * Used by `validateCanonicalSections` to report missing sections.
 */
const CANONICAL_SECTION_CHECKS: ReadonlyArray<{ name: string; headers: Set<string> }> = [
  { name: 'Objective',           headers: OBJECTIVE_HEADERS },
  { name: 'Context',             headers: CONTEXT_HEADERS },
  { name: 'Goal',                headers: GOAL_HEADERS },
  { name: 'Scope',               headers: SCOPE_HEADERS },
  { name: 'Acceptance Criteria', headers: REQUIREMENTS_HEADERS },
  { name: 'Validation',          headers: VALIDATION_HEADERS },
  { name: 'Ordering',            headers: ORDERING_HEADERS },
  { name: 'Non-goals',           headers: NON_GOALS_HEADERS },
];

/**
 * Split a markdown text into sections keyed by their normalized `##` header lines.
 *
 * @returns A Map where each key is a section header normalized by trimming and lowercasing, and each value is the raw content following that header (excluding the header line).
 */
function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.split(/^##\s+/m);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const header = part.slice(0, nl).trim().toLowerCase();
    const content = part.slice(nl + 1);
    sections.set(header, content);
  }
  return sections;
}

/**
 * Extracts bullet list items from the given text and returns them as trimmed strings.
 *
 * This is a generic list parser used by all section types (Validation, Acceptance
 * Criteria, Ordering, Non-goals, etc.). It does NOT strip parenthetical annotations
 * — that logic is scope-specific and handled separately.
 *
 * @param text - Section content to scan for bullet list lines (lines starting with `- ` or `* `)
 * @returns The extracted list item strings, trimmed of whitespace; empty items are omitted.
 */
function parseListItems(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^\s*[-*]\s/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((s) => s.length > 0);
}

/**
 * Removes trailing parenthetical annotations from a string.
 *
 * Used exclusively for Scope section items to strip annotations like "(new)" or
 * "(thread flag through...)" so that allowed_scope entries in worker packets
 * contain only bare file paths or valid glob patterns.
 *
 * @param s - The string to process
 * @returns The input string with trailing `(...)` removed, re-trimmed
 */
function stripTrailingParenthetical(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Extracts list items from the first section whose header matches a provided set.
 *
 * This is a generic section parser that does NOT apply any parenthetical stripping.
 * For Scope sections, use `findScopeSection` instead.
 *
 * @param sections - Map of normalized header names to their section content; iteration follows the map's order
 * @param headers - Set of normalized header names to match against section headers
 * @returns An array of parsed list-item strings from the first matching section, or an empty array if no match is found
 */
function findSection(sections: Map<string, string>, headers: Set<string>): string[] {
  for (const [header, content] of sections) {
    if (headers.has(header)) {
      return parseListItems(content);
    }
  }
  return [];
}

/**
 * Extracts list items from the Scope section, stripping trailing parenthetical annotations.
 *
 * Scope section items often include human-readable annotations like "(new)" or
 * "(thread flag through...)". These are stripped so that allowed_scope entries in
 * worker packets contain only bare file paths or valid glob patterns.
 *
 * @param sections - Map of normalized header names to their section content
 * @param headers - Set of normalized Scope header variants (e.g., SCOPE_HEADERS)
 * @returns An array of scope paths with parentheticals removed, or an empty array if no Scope section is found
 */
function findScopeSection(sections: Map<string, string>, headers: Set<string>): string[] {
  for (const [header, content] of sections) {
    if (headers.has(header)) {
      return parseListItems(content).map(stripTrailingParenthetical).filter((s) => s.length > 0);
    }
  }
  return [];
}

/**
 * Returns trimmed prose text from the first section matching a header set.
 * Used for single-paragraph sections (Objective, Context, Goal).
 */
function findSectionText(sections: Map<string, string>, headers: Set<string>): string {
  for (const [header, content] of sections) {
    if (headers.has(header)) {
      return content.trim();
    }
  }
  return '';
}

/**
 * Parse a markdown issue body into structured fields.
 *
 * Recognizes `##` sections and extracts bullet list items (`-` or `*`) from the first matching header for each field.
 * Prose sections (Objective, Context, Goal) are returned as trimmed text.
 *
 * TBD-blocked scope: if every item in the `## Scope` section begins with "TBD"
 * the scope is treated as empty (`scope: []`) and `scopeBlocked` is set to `true`.
 * This ensures the preflight gate fires instead of dispatching a worker with an
 * unusable scope list.
 *
 * @param body - The markdown issue body to parse.
 * @returns Structured fields; each array/string is empty when the input is empty/whitespace or no matching section is found.
 */
export function parseIssueBody(body: string): ParsedIssueBody {
  if (!body || !body.trim()) {
    return {
      scope: [],
      scopeBlocked: false,
      validationCommands: [],
      requirements: [],
      objective: '',
      context: '',
      goal: '',
      ordering: [],
      nonGoals: [],
    };
  }
  const sections = parseSections(body);

  const rawScope = findScopeSection(sections, SCOPE_HEADERS);
  const scopeBlocked = rawScope.length > 0 && rawScope.every((item) => TBD_BLOCKED_RE.test(item));
  const filteredScope = rawScope.filter((item) => !TBD_BLOCKED_RE.test(item));

  return {
    scope: scopeBlocked ? [] : filteredScope,
    scopeBlocked,
    validationCommands: findSection(sections, VALIDATION_HEADERS),
    requirements: findSection(sections, REQUIREMENTS_HEADERS),
    objective: findSectionText(sections, OBJECTIVE_HEADERS),
    context: findSectionText(sections, CONTEXT_HEADERS),
    goal: findSectionText(sections, GOAL_HEADERS),
    ordering: findSection(sections, ORDERING_HEADERS),
    nonGoals: findSection(sections, NON_GOALS_HEADERS),
  };
}

/**
 * Checks a markdown issue body for the presence of all 8 required canonical sections.
 *
 * @param body - The markdown issue body to validate.
 * @returns Names of any canonical sections that are absent. Empty array means the body is fully canonical.
 */
export function validateCanonicalSections(body: string): string[] {
  if (!body || !body.trim()) {
    return CANONICAL_SECTION_CHECKS.map((c) => c.name);
  }
  const sections = parseSections(body);
  const sectionKeys = [...sections.keys()];
  const missing: string[] = [];
  for (const { name, headers } of CANONICAL_SECTION_CHECKS) {
    if (!sectionKeys.some((key) => headers.has(key))) {
      missing.push(name);
    }
  }
  return missing;
}
