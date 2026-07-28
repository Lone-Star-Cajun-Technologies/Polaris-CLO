import type { ExecutionConfig } from "../../config/schema.js";
import type { BootstrapPacket, DispatchOptions, DispatchResult, ExecutionAdapter } from "./types.js";

/**
 * Paperclip execution adapter. Dispatches a Polaris child task to the
 * Paperclip control plane by injecting a structured coords block into the
 * issue description so the assigned worker always knows where to work.
 *
 * Coords (repoUrl / workingDirectory / targetPaths) come from two sources,
 * merged with packet taking precedence over config:
 *   1. packet.repo_coordinates (set by the foreman at packet-build time)
 *   2. config.paperclip.repoUrl / workingDirectory / targetPaths
 *
 * Enforced at adapter level — dispatch() without resolvable coords fails
 * with pre_dispatch_failure: true. HTTP transport pending LSC-22.
 * Do not add a second paperclip.ts; extend this one.
 */

export interface RepoCoordinates {
  repoUrl: string;
  workingDirectory: string;
  targetPaths: string[];
}

/**
 * Build the <!-- POLARIS_COORDS --> block injected into every Paperclip issue
 * description. This is the authoritative serialization format for LSC-32.
 */
export function buildCoordsBlock(coords: RepoCoordinates): string {
  const payload = {
    repoUrl: coords.repoUrl,
    workingDirectory: coords.workingDirectory,
    targetPaths: coords.targetPaths,
  };
  return [
    "<!-- POLARIS_COORDS",
    JSON.stringify(payload, null, 2),
    "POLARIS_COORDS -->",
  ].join("\n");
}

/**
 * Resolve coordinates from packet and config, packet taking precedence.
 * Returns null when repoUrl or workingDirectory cannot be determined.
 */
export function resolveCoords(
  packet: BootstrapPacket,
  config: ExecutionConfig,
): RepoCoordinates | null {
  const pc = packet.repo_coordinates;
  const cfg = config.paperclip;

  const repoUrl = pc?.repoUrl ?? cfg?.repoUrl ?? "";
  const workingDirectory = pc?.workingDirectory ?? cfg?.workingDirectory ?? "";
  const targetPaths = pc?.targetPaths ?? cfg?.targetPaths ?? [];

  if (!repoUrl || !workingDirectory) {
    return null;
  }

  return { repoUrl, workingDirectory, targetPaths };
}

export class PaperclipAdapter implements ExecutionAdapter {
  readonly name = "paperclip";

  constructor(private readonly config: ExecutionConfig) {}

  async dispatch(packet: BootstrapPacket, _options: DispatchOptions): Promise<DispatchResult> {
    const coords = resolveCoords(packet, this.config);

    if (!coords) {
      return {
        exit_code: 1,
        provider_used: "paperclip",
        command_run: "",
        pre_dispatch_failure: true,
        failure_origin: "provider-launch",
        failure_category: "provider-unavailable",
        fallback_eligible: false,
        summary:
          "Paperclip adapter requires repo coordinates (repoUrl + workingDirectory). " +
          "Set packet.repo_coordinates or config.paperclip.repoUrl / workingDirectory.",
      };
    }

    const coordsBlock = buildCoordsBlock(coords);
    // Build the issue description that would be sent to the Paperclip API.
    const description =
      `Active child: ${packet.active_child}\n` +
      `Run ID: ${packet.run_id}\n\n` +
      coordsBlock;

    // HTTP transport (create/poll/reconcile) is pending LSC-22.
    // Return pre_dispatch_failure so foreman can roll back cleanly.
    // Expose the built description via stdout so dryRun callers can inspect it.
    return {
      exit_code: 1,
      provider_used: "paperclip",
      command_run: "",
      pre_dispatch_failure: true,
      failure_origin: "provider-launch",
      failure_category: "provider-unavailable",
      fallback_eligible: false,
      summary: "Paperclip adapter HTTP transport not yet implemented (pending LSC-22).",
      stdout: description,
    };
  }
}
