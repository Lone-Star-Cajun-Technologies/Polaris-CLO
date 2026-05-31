import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveRepoRoot } from "../lib/root.js";
import { redact } from "../lib/redact.js";

export interface CurrentStateArgs {
  artifact_dir?: string;
}

function isValidDirName(name: string): boolean {
  return /^[\w][\w.-]*$/.test(name) && !name.includes("..");
}

export async function handlePolarisCurrentState(
  args: CurrentStateArgs,
): Promise<Record<string, unknown>> {
  const repoRoot = resolveRepoRoot();

  const artifactDir = args.artifact_dir ?? "polaris-run";

  if (typeof artifactDir !== "string") {
    return {
      ok: false,
      error: "invalid_argument",
      message: `artifact_dir must be a string, received ${typeof artifactDir}: ${JSON.stringify(artifactDir)}`,
    };
  }

  if (!isValidDirName(artifactDir)) {
    return {
      ok: false,
      error: "invalid_argument",
      message: `artifact_dir contains invalid characters: ${artifactDir}`,
    };
  }

  const statePath = resolve(
    join(repoRoot, ".taskchain_artifacts", artifactDir, "current-state.json"),
  );

  if (!statePath.startsWith(repoRoot)) {
    return {
      ok: false,
      error: "invalid_argument",
      message: "artifact_dir resolved outside repo root",
    };
  }

  let raw: string;
  try {
    const realStatePath = realpathSync(statePath);
    const realRepoRoot = realpathSync(repoRoot);

    if (!realStatePath.startsWith(realRepoRoot + sep)) {
      return {
        ok: false,
        error: "invalid_argument",
        message: "artifact_dir resolved outside repo root (symlink detected)",
      };
    }

    raw = readFileSync(realStatePath, "utf-8");
  } catch {
    return {
      ok: false,
      error: "state_not_found",
      message: `State file not found: .taskchain_artifacts/${artifactDir}/current-state.json`,
      hint: "Run a polaris cluster session first to create current-state.json",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: "parse_error",
      message: "current-state.json is not valid JSON",
    };
  }

  return {
    ok: true,
    artifact_dir: artifactDir,
    state: redact(parsed),
  };
}
