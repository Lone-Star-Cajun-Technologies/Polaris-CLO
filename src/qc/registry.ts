/**
 * Default QC provider registry.
 *
 * Registers all built-in QC adapters. In the future this can be extended to
 * discover providers from configuration or installed plugins.
 */

import { QcProviderRegistry } from "./provider.js";
import { CodeRabbitQcProvider } from "./providers/coderabbit.js";

export function createDefaultQcRegistry(): QcProviderRegistry {
  const registry = new QcProviderRegistry();
  registry.register(new CodeRabbitQcProvider());
  return registry;
}
