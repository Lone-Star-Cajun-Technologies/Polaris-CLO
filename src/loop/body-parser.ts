/**
 * Issue body section parser.
 *
 * Parses a markdown issue body into structured fields used by the packet
 * generator. Sections are identified by `## Header` lines (case-insensitive).
 * List items are lines starting with `- ` or `* `.
 *
 * ## Scope inheritance precedence
 *
 * When `buildPacket` resolves `allowed_scope` for a worker packet, it applies
 * the following rules in order (first non-empty result wins):
 *
 *   1. Explicit `allowedScope` passed to `compileImplPacket` by the caller.
 *   2. Child issue body `## Scope` / `## Expected code areas` section.
 *   3. Cluster-root (parent) body `## Scope` section — fallback only when the
 *      child body has no scope section at all.
 *   4. Empty → preflight gate halts dispatch with `preflight-scope-missing`.
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
  validationCommands: string[];
  requirements: string[];
}

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

function parseListItems(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^\s*[-*]\s/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((s) => s.length > 0);
}

function findSection(sections: Map<string, string>, headers: Set<string>): string[] {
  for (const [header, content] of sections) {
    if (headers.has(header)) {
      return parseListItems(content);
    }
  }
  return [];
}

/**
 * Parse a markdown issue body into structured fields.
 *
 * Sections recognized:
 * - `## Scope` / `## Expected code areas` / `## Code areas` → `scope`
 * - `## Validation` / `## Validation commands` → `validationCommands`
 * - `## Acceptance Criteria` / `## Requirements` → `requirements`
 */
export function parseIssueBody(body: string): ParsedIssueBody {
  if (!body || !body.trim()) {
    return { scope: [], validationCommands: [], requirements: [] };
  }
  const sections = parseSections(body);
  return {
    scope: findSection(sections, SCOPE_HEADERS),
    validationCommands: findSection(sections, VALIDATION_HEADERS),
    requirements: findSection(sections, REQUIREMENTS_HEADERS),
  };
}
