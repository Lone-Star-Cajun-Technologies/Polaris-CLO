/**
 * Route-local cognition delta logic.
 *
 * Workers call applyRouteCognitionDelta() after implementation to determine
 * whether POLARIS.md needs updating for the folders they touched. Updates are
 * delta-only: only apply when operationally-relevant changes occurred.
 *
 * Root cognition surfaces (POLARIS.md at repo root) are skipped unless
 * explicitly opted in. Bounded by locality — no repo-wide scanning.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isDirectoryEligible, parseSmartDocIgnore } from "../smartdocs-engine/smartdoc-ignore.js";
import type { FileRouteEntry } from "../map/atlas.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RouteHealthState = "healthy" | "recovering" | "monitoring" | "known-issues" | "stale";

export interface CognitionDeltaOptions {
  repoRoot: string;
  /** Files touched during this child's implementation. */
  touchedFiles: string[];
  /**
   * Skip updating the root POLARIS.md (repo root). Default: true.
   * Root cognition belongs in AGENTS.md / CLAUDE.md per doctrine.
   */
  skipRoot?: boolean;
}

// ── Route Health Assessment ───────────────────────────────────────────────────

/**
 * Assess the health state of a route based on observable signals.
 *
 * Signals used:
 * - Staleness: entry older than threshold (default 90 days)
 * - Identity completeness: missing instructionFile or role_owner
 *
 * Returns:
 * - "stale": entry is stale (older than threshold)
 * - "known-issues": identity incomplete (missing instructionFile or role_owner)
 * - "healthy": route is fresh, identity complete
 */
export function assessRouteHealth(
  route: FileRouteEntry,
  repoRoot: string,
  staleThresholdDays: number = 90,
): RouteHealthState {
  const daysSinceUpdate = (Date.now() - new Date(route.last_updated).getTime()) / (1000 * 60 * 60 * 24);

  // Staleness check (highest priority)
  if (daysSinceUpdate > staleThresholdDays) {
    return "stale";
  }

  // Identity completeness check
  const hasInstructionFile = route.instructionFile !== undefined && route.instructionFile !== null && route.instructionFile.trim() !== "";
  const hasRoleOwner = route.role_owner !== undefined && route.role_owner !== null && route.role_owner.trim() !== "";

  if (!hasInstructionFile || !hasRoleOwner) {
    return "known-issues";
  }

  // Cognition surface check: instructionFile configured but file missing on disk
  const instructionFileAbs = join(repoRoot, route.instructionFile!);
  if (!existsSync(instructionFileAbs)) {
    return "monitoring";
  }

  // Recovery window: recently updated (7–threshold days ago)
  if (daysSinceUpdate > 7) {
    return "recovering";
  }

  return "healthy";
}

export type CognitionUpdateReason =
  | "folder-responsibilities-changed"
  | "commands-workflows-changed"
  | "execution-constraints-changed"
  | "ownership-routing-changed"
  | "operational-behavior-changed";

export interface CognitionDeltaResult {
  /** Folders that were inspected. */
  inspectedFolders: string[];
  /** Nearest POLARIS.md candidates found per folder. */
  routeLocalTargets: string[];
  /** Whether any POLARIS.md update is warranted. */
  updateWarranted: boolean;
  /** Reasons why an update is warranted (empty when not warranted). */
  reasons: CognitionUpdateReason[];
  /** Folders whose POLARIS.md is missing (newly eligible). */
  missingCognitionSurfaces: string[];
  /** Health state of the route (if applicable). */
  healthState?: RouteHealthState;
}

// ── Skipped folder patterns ───────────────────────────────────────────────────

const SKIP_FOLDER_PREFIXES = [
  ".git/",
  "node_modules/",
  "dist/",
  ".taskchain_artifacts/",
];

const AGENT_OPT_IN_FOLDERS = new Set([".claude", ".codex"]);
const POLARIS_RUNTIME_COGNITION_FOLDERS = new Set([
  ".polaris",
  ".polaris/bootstrap",
  ".polaris/clusters",
  ".polaris/map",
  ".polaris/runs",
]);
const POLARIS_RUNTIME_GENERATED_PREFIXES = [
  ".polaris/bootstrap/",
  ".polaris/clusters/",
  ".polaris/graph/",
  ".polaris/map/",
  ".polaris/runs/",
];

export const POLARIS_OWNED_COGNITION_FOLDERS = [
  ".polaris",
  "src",
  "smartdocs/specs/active",
  "smartdocs/doctrine/active",
] as const;

function normalizeRelPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function readManagedSurfaceManifest(repoRoot: string): Set<string> {
  const manifestPath = join(repoRoot, ".polaris", "cognition", "managed-surfaces.json");
  if (!existsSync(manifestPath)) return new Set();

  const raw = readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const paths: string[] = [];
  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      if (typeof value === "string") paths.push(value);
    }
  } else if (parsed && typeof parsed === "object") {
    const candidateArrays = [
      (parsed as Record<string, unknown>)["surfaces"],
      (parsed as Record<string, unknown>)["managed_surfaces"],
      (parsed as Record<string, unknown>)["managedSurfaces"],
      (parsed as Record<string, unknown>)["paths"],
    ];
    for (const candidate of candidateArrays) {
      if (!Array.isArray(candidate)) continue;
      for (const value of candidate) {
        if (typeof value === "string") paths.push(value);
      }
    }
  }

  return new Set(paths.map((p) => normalizeRelPath(p)));
}

/**
 * Tier 1 folders that are always considered Polaris-owned cognition surfaces.
 *
 * Includes fixed roots and dynamic immediate children under src/<subdirectory>.
 */
export function isPolarisOwnedFolder(folderRel: string): boolean {
  const normalized = normalizeRelPath(folderRel);
  if (!normalized) return false;
  if (POLARIS_OWNED_COGNITION_FOLDERS.includes(normalized as (typeof POLARIS_OWNED_COGNITION_FOLDERS)[number])) {
    return true;
  }
  return /^src\/[^/]+$/.test(normalized);
}

/**
 * Returns true when a cognition surface should be treated as user-created and
 * therefore protected from worker overwrites.
 *
 * A surface is protected when either:
 * 1) It predates Polaris initialization (.polaris birth/creation time), or
 * 2) It is listed in .polaris/cognition/managed-surfaces.json.
 */
export function isUserCreatedCognitionSurface(filePath: string, repoRoot: string): boolean {
  const absFile = resolve(repoRoot, filePath);
  const relFile = normalizeRelPath(relative(repoRoot, absFile));
  if (!relFile || relFile.startsWith("..")) return false;

  const managed = readManagedSurfaceManifest(repoRoot);
  if (managed.has(relFile)) return true;

  if (!existsSync(absFile)) return false;
  const polarisDir = join(repoRoot, ".polaris");
  if (!existsSync(polarisDir)) return false;

  const fileStat = statSync(absFile);
  const polarisStat = statSync(polarisDir);
  const polarisInitializedAt = polarisStat.birthtimeMs > 0 ? polarisStat.birthtimeMs : polarisStat.ctimeMs;
  return fileStat.mtimeMs < polarisInitializedAt;
}

/**
 * Returns true when a folder is skipped for route-local cognition:
 * generated, runtime, ignored, or agent-only-with-no-opt-in.
 *
 * When repoRoot is provided, also consults .smartdocignore and the shared
 * smartdoc-ignore eligibility rules (RUNTIME_EXCLUDED_DIR_PATTERNS,
 * AGENT_COGNITION_FOLDERS, HIDDEN_SYSTEM_FOLDERS). This ensures cognition
 * scanning honours the same boundaries as Smart Docs ingest.
 */
export function isCognitionSkippedFolder(folderRel: string, repoRoot?: string): boolean {
  // Fast-path: hardcoded runtime/bootstrap prefixes (no fs needed)
  for (const prefix of SKIP_FOLDER_PREFIXES) {
    if (folderRel === prefix.slice(0, -1) || folderRel.startsWith(prefix)) {
      return true;
    }
  }
  if (POLARIS_RUNTIME_COGNITION_FOLDERS.has(folderRel)) return false;
  for (const prefix of POLARIS_RUNTIME_GENERATED_PREFIXES) {
    const rootPath = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (folderRel === rootPath || folderRel.startsWith(prefix)) return true;
  }
  // Agent folders are opt-in only
  const topLevel = folderRel.split("/")[0] ?? folderRel;
  if (AGENT_OPT_IN_FOLDERS.has(topLevel)) return true;

  // When repoRoot is available, defer to the smartdoc-ignore authority.
  // This ensures .smartdocignore patterns and shared exclusion lists are
  // honoured — POLARIS.md and SUMMARY.md are bounded agent/context files,
  // not ingest candidates.
  if (repoRoot) {
    const eligibility = isDirectoryEligible(folderRel, repoRoot);
    if (!eligibility.eligible) return true;
    // Also check .smartdocignore patterns directly for directory paths
    if (!folderRel.startsWith(".polaris")) {
      const ig = parseSmartDocIgnore(repoRoot);
      if (ig.ignores(folderRel) || ig.ignores(`${folderRel}/`)) return true;
    }
  }

  return false;
}

// ── Nearest route-local POLARIS.md ────────────────────────────────────────────

/**
 * Walk upward from `filePath` (relative to repoRoot) and return the nearest
 * non-root POLARIS.md. Returns null when only root or no POLARIS.md exists.
 */
export function findNearestRoutePolarismd(
  filePath: string,
  repoRoot: string,
  skipRoot: boolean,
): string | null {
  const parts = filePath.split("/");
  // Walk from deepest dir upward, excluding the root level when skipRoot=true
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join("/");
    if (isCognitionSkippedFolder(dir, repoRoot)) continue;
    const candidate = join(repoRoot, dir, "POLARIS.md");
    if (existsSync(candidate)) {
      return relative(repoRoot, candidate).replace(/\\/g, "/");
    }
  }
  // Fall back to root only when not skipping root
  if (!skipRoot) {
    const rootCandidate = join(repoRoot, "POLARIS.md");
    if (existsSync(rootCandidate)) return "POLARIS.md";
  }
  return null;
}

// ── Change signal detection ───────────────────────────────────────────────────

/** Signals in a file path that suggest operational relevance. */
const OPERATIONAL_SIGNALS: Array<{ pattern: RegExp; reason: CognitionUpdateReason }> = [
  { pattern: /\/index\.ts$/, reason: "folder-responsibilities-changed" },
  { pattern: /\/cli\//,       reason: "commands-workflows-changed" },
  { pattern: /\/commands?\//,  reason: "commands-workflows-changed" },
  { pattern: /scripts\//,      reason: "commands-workflows-changed" },
  { pattern: /\/config\//,     reason: "execution-constraints-changed" },
  { pattern: /\/schema\.ts$/,  reason: "execution-constraints-changed" },
  { pattern: /\/loader\.ts$/,  reason: "execution-constraints-changed" },
  { pattern: /\/map\//,        reason: "ownership-routing-changed" },
  { pattern: /\/atlas\.ts$/,   reason: "ownership-routing-changed" },
  { pattern: /\/inference\.ts$/, reason: "ownership-routing-changed" },
  { pattern: /\/dispatch/,     reason: "operational-behavior-changed" },
  { pattern: /\/worker\.ts$/,  reason: "operational-behavior-changed" },
  { pattern: /\/parent\.ts$/,  reason: "operational-behavior-changed" },
  { pattern: /\/finalize\//,   reason: "operational-behavior-changed" },
  { pattern: /\/cognition\//,  reason: "operational-behavior-changed" },
];

/**
 * Determine whether a set of touched files warrants a POLARIS.md update.
 * Returns the reasons found; empty array means no update warranted.
 */
export function detectOperationalReasons(
  touchedFiles: string[],
): CognitionUpdateReason[] {
  const reasonSet = new Set<CognitionUpdateReason>();
  for (const file of touchedFiles) {
    // Skip test files, comments-only changes, etc.
    if (file.endsWith(".test.ts") || file.endsWith(".test.js")) continue;
    if (file.endsWith(".md") || file.endsWith(".json")) {
      // Only config json or doc-linking md are operationally relevant
      if (!file.includes("config") && !file.endsWith("POLARIS.md") && !file.endsWith("SUMMARY.md")) {
        continue;
      }
    }
    for (const signal of OPERATIONAL_SIGNALS) {
      if (signal.pattern.test(file)) {
        reasonSet.add(signal.reason);
      }
    }
  }
  return Array.from(reasonSet);
}

// ── Missing surface detection ─────────────────────────────────────────────────

/**
 * For each touched file, check whether its nearest eligible folder has a
 * POLARIS.md. Return folders that are newly eligible but missing one.
 */
function detectMissingCognitionSurfaces(
  touchedFiles: string[],
  repoRoot: string,
  skipRoot: boolean,
): string[] {
  const missing = new Set<string>();
  for (const file of touchedFiles) {
    const parts = file.split("/");
    for (let i = parts.length - 1; i >= 1; i--) {
      const dir = parts.slice(0, i).join("/");
      if (isCognitionSkippedFolder(dir, repoRoot)) continue;
      const candidate = join(repoRoot, dir, "POLARIS.md");
      if (!existsSync(candidate)) {
        // Only report if there are source files in this folder (not empty dirs)
        missing.add(dir);
      }
      break; // Only report the nearest ancestor folder per file
    }
  }
  return Array.from(missing);
}

// ── Main delta entry point ────────────────────────────────────────────────────

/**
 * Apply route-local cognition delta logic after child implementation.
 *
 * Does NOT write POLARIS.md. Returns a result describing what was found so
 * that the worker prompt can instruct the agent accordingly, or the caller can
 * conditionally trigger an update.
 */
export function applyRouteCognitionDelta(
  options: CognitionDeltaOptions,
): CognitionDeltaResult {
  const { repoRoot, touchedFiles, skipRoot = true } = options;

  const inspectedFolders = new Set<string>();
  const routeLocalTargets = new Set<string>();
  const missingCognitionSurfaces: string[] = [];

  for (const file of touchedFiles) {
    const dir = dirname(file);
    if (dir && dir !== ".") {
      if (!isCognitionSkippedFolder(dir)) {
        inspectedFolders.add(dir);
      }
    }
    const target = findNearestRoutePolarismd(file, repoRoot, skipRoot);
    if (target) routeLocalTargets.add(target);
  }

  const reasons = detectOperationalReasons(touchedFiles);
  const updateWarranted = reasons.length > 0;
  const missing = detectMissingCognitionSurfaces(touchedFiles, repoRoot, skipRoot);
  missingCognitionSurfaces.push(...missing);

  return {
    inspectedFolders: Array.from(inspectedFolders),
    routeLocalTargets: Array.from(routeLocalTargets),
    updateWarranted,
    reasons,
    missingCognitionSurfaces,
    healthState: undefined,
  };
}

// ── POLARIS.md content read helper ────────────────────────────────────────────

/**
 * Read the content of a route-local POLARIS.md (relative to repoRoot).
 * Returns null when missing.
 */
export function readRoutePolarismd(polarisRel: string, repoRoot: string): string | null {
  const abs = resolve(repoRoot, polarisRel);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}
