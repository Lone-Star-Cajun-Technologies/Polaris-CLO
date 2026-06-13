import type { TriageReviewPacket } from "../governance/types.js";

// ---------------------------------------------------------------------------
// Shared document metadata shape used internally by triage
// ---------------------------------------------------------------------------

export interface DocMeta {
  path: string;
  tags: string[];
  type: string;
  clusterMembership: string[];
  relatedNotes: string[];
  filenamePrefixes: string[];
}

export interface Cluster {
  candidates: DocMeta[];
  canonicals: DocMeta[];
}

export type ClusterMap = Record<string, Cluster>;

// ---------------------------------------------------------------------------
// clusterCandidates
// ---------------------------------------------------------------------------

/**
 * Groups candidate docs into named clusters using metadata overlap with canonicals.
 * Candidates with no signal match go into the "general" bucket.
 */
export function clusterCandidates(candidates: DocMeta[], canonicals: DocMeta[]): ClusterMap {
  const clusters: ClusterMap = {};

  // Build cluster names from canonicals
  for (const canonical of canonicals) {
    const names = clusterNamesFor(canonical);
    for (const name of names) {
      if (!clusters[name]) {
        clusters[name] = { candidates: [], canonicals: [] };
      }
      if (!clusters[name].canonicals.includes(canonical)) {
        clusters[name].canonicals.push(canonical);
      }
    }
  }

  // Assign each candidate to its best cluster
  for (const candidate of candidates) {
    const candidateNames = clusterNamesFor(candidate);
    let assigned = false;

    for (const name of candidateNames) {
      if (clusters[name]) {
        clusters[name].candidates.push(candidate);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      if (!clusters["general"]) {
        clusters["general"] = { candidates: [], canonicals: [] };
      }
      clusters["general"].candidates.push(candidate);
    }
  }

  // Ensure general bucket exists
  if (!clusters["general"]) {
    clusters["general"] = { candidates: [], canonicals: [] };
  }

  return clusters;
}

function clusterNamesFor(doc: DocMeta): string[] {
  const names: string[] = [];

  // Tags take priority
  for (const tag of doc.tags) {
    if (tag.trim()) names.push(tag.toLowerCase().trim());
  }

  // Cluster membership
  for (const c of doc.clusterMembership) {
    if (c.trim()) names.push(c.toLowerCase().trim());
  }

  // Filename prefix (e.g. "ADR", "EVOlearn")
  for (const p of doc.filenamePrefixes) {
    if (p.trim()) names.push(p.toLowerCase().trim());
  }

  // Type as fallback
  if (doc.type.trim()) names.push(doc.type.toLowerCase().trim());

  return names;
}

// ---------------------------------------------------------------------------
// extractSymbols
// ---------------------------------------------------------------------------

const BACKTICK_RE = /`([A-Za-z_][A-Za-z0-9_]{3,})`/g;
const CAMEL_PASCAL_RE = /(?<![`\w])([A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z][a-z]+(?:[A-Z][a-z0-9]+)+)(?![`\w])/g;

/**
 * Extracts likely code symbol names from markdown text.
 * Returns deduplicated symbol names of 4+ characters.
 */
export function extractSymbols(text: string): string[] {
  const found = new Set<string>();

  let m: RegExpExecArray | null;

  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(text)) !== null) {
    found.add(m[1]);
  }

  CAMEL_PASCAL_RE.lastIndex = 0;
  while ((m = CAMEL_PASCAL_RE.exec(text)) !== null) {
    found.add(m[1]);
  }

  return Array.from(found);
}

// ---------------------------------------------------------------------------
// Placeholder exports referenced in later tasks (stubs — filled in Task 3+)
// ---------------------------------------------------------------------------

export interface TriageOptions {
  repoRoot: string;
  batchSize?: number;
  resume?: boolean;
  dryRun?: boolean;
  output?: (msg: string) => void;
  llmClient?: LlmClient;
  symbolLookup?: (name: string) => boolean;
  graphStats?: () => { symbolCount: number };
}

export interface TriageResult {
  flagCount: number;
  outputDir: string;
}

export interface LlmClient {
  compare(
    candidates: DocMeta[],
    canonicals: DocMeta[],
    model: string,
  ): Promise<TriageLlmFlag[]>;
}

export interface TriageLlmFlag {
  candidatePath: string;
  flagType: "contradiction" | "duplicate";
  canonicalPath?: string;
  reason: string;
}

// Stubs — implemented in later tasks
export async function runTriage(_options: TriageOptions): Promise<TriageResult> {
  throw new Error("not implemented");
}
