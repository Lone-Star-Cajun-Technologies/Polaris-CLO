import type { AdapterRegistry, LanguageAdapter } from "./types.js";
import { createTypeScriptJavaScriptAdapter } from "./typescript-javascript/index.js";

export class GraphAdapterRegistry implements AdapterRegistry {
  private readonly adaptersByLanguage = new Map<string, LanguageAdapter>();

  private readonly adaptersByExtension = new Map<string, LanguageAdapter>();

  register(adapter: LanguageAdapter): void {
    if (this.adaptersByLanguage.has(adapter.languageId)) {
      throw new Error(`Language adapter already registered: ${adapter.languageId}`);
    }

    // Validate all extensions first before mutating state
    const normalizedExtensions: string[] = [];
    for (const extension of adapter.fileExtensions) {
      const normalized = normalizeExtension(extension);
      const existing = this.adaptersByExtension.get(normalized);
      if (existing) {
        throw new Error(`File extension ${normalized} is already handled by adapter ${existing.languageId}`);
      }
      normalizedExtensions.push(normalized);
    }

    // Only mutate state after validation completes
    this.adaptersByLanguage.set(adapter.languageId, adapter);
    for (const normalized of normalizedExtensions) {
      this.adaptersByExtension.set(normalized, adapter);
    }
  }

  getForExtension(extension: string): LanguageAdapter | null {
    if (!extension || extension.trim().length === 0) {
      return null;
    }
    return this.adaptersByExtension.get(normalizeExtension(extension)) ?? null;
  }

  getSupportedExtensions(): string[] {
    return Array.from(this.adaptersByExtension.keys()).sort((left, right) => left.localeCompare(right));
  }

  getAll(): LanguageAdapter[] {
    return Array.from(this.adaptersByLanguage.values());
  }
}

let defaultRegistry: AdapterRegistry | null = null;

export function getDefaultAdapterRegistry(): AdapterRegistry {
  if (defaultRegistry) {
    return defaultRegistry;
  }

  const registry = new GraphAdapterRegistry();
  registry.register(createTypeScriptJavaScriptAdapter());
  defaultRegistry = registry;
  return defaultRegistry;
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error("Adapter extension cannot be empty.");
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
