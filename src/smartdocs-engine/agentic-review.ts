import type { ReviewPacket } from "../governance/types.js";
import { dispatchLibrarianReview, resolveLibrarianProvider } from "./librarian-dispatch.js";
import { loadConfig } from "../config/loader.js";

export async function agenticDecideKey(packet: ReviewPacket): Promise<string> {
  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig(process.cwd());
  } catch {
    throw new Error(
      "polaris agent setup required: could not load polaris.config.json.\n" +
      "Run `polaris agent setup` to configure a librarian or foreman agent.",
    );
  }

  const providers = (config.execution?.providers ?? {}) as Record<string, { command: string; args: string[] }>;
  const librarianOrder: string[] = config.execution?.providerPolicy?.librarian?.providers ?? [];
  const foremanOrder: string[] = (config.execution?.providerPolicy as Record<string, { providers?: string[] }>)?.foreman?.providers ?? [];

  // Try librarian first, then foreman as fallback
  const resolvedRole =
    resolveLibrarianProvider(providers, librarianOrder) != null ? "librarian"
    : resolveLibrarianProvider(providers, foremanOrder) != null ? "foreman"
    : null;

  if (!resolvedRole) {
    const configured = [...new Set([...librarianOrder, ...foremanOrder])];
    const msg = configured.length > 0
      ? `Configured agents (${configured.join(", ")}) are not installed on this machine.`
      : "No librarian or foreman agents are configured.";
    throw new Error(
      `polaris agent setup required: ${msg}\n` +
      "Run `polaris agent setup` to configure an available agent.",
    );
  }

  const providerOrder = resolvedRole === "librarian" ? librarianOrder : foremanOrder;
  const result = await dispatchLibrarianReview({ packet, repoRoot: process.cwd(), providers, providerOrder });

  if (result.decision === "approve") return "a";
  if (result.decision === "reject") return "r";
  return "d";
}
