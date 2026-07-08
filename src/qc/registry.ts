/**
 * QC provider registry builders.
 *
 * `createDefaultQcRegistry` returns the static built-in registry for backward
 * compatibility. `createQcRegistry` builds a registry from polaris.config.json
 * qc.providers, wiring provider-agnostic command/output config into the
 * matching built-in adapters.
 */

import type { QcConfig, QcProviderConfig } from "../config/schema.js";
import { QcProviderRegistry } from "./provider.js";
import { CodeRabbitQcProvider } from "./providers/coderabbit.js";

function createProvider(name: string, config?: QcProviderConfig): CodeRabbitQcProvider | undefined {
  // Only CodeRabbit is supported as a concrete provider in this child.
  // Future providers can be registered here by name.
  if (name === "coderabbit") {
    return new CodeRabbitQcProvider(config);
  }
  return undefined;
}

export function createDefaultQcRegistry(): QcProviderRegistry {
  const registry = new QcProviderRegistry();
  registry.register(new CodeRabbitQcProvider());
  return registry;
}

/**
 * Build a registry from configured QC providers.
 *
 * Disabled providers (enabled: false) are skipped. Unknown provider names are
 * skipped; callers should validate config before dispatch and may report
 * unknown providers as blockers at runtime.
 */
export function createQcRegistry(config: QcConfig | undefined): QcProviderRegistry {
  const registry = new QcProviderRegistry();
  if (!config?.enabled) {
    return registry;
  }

  for (const [name, providerConfig] of Object.entries(config.providers ?? {})) {
    if (providerConfig.enabled === false) continue;
    const provider = createProvider(name, providerConfig);
    if (provider) {
      registry.register(provider);
    }
  }

  return registry;
}
