import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractDartSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type DartParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".dart"] as const;

export interface DartAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class DartAdapter implements LanguageAdapter {
  readonly languageId = "dart";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "medium" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (classes, top-level functions, class methods, imports).",
    "Does not perform call/reference extraction in phase 1.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported Dart file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractDartSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed.startsWith("package:") || trimmed.startsWith("dart:")) {
      return trimmed;
    }

    if (trimmed.startsWith(".")) {
      if (extname(trimmed).length > 0) {
        return trimmed;
      }

      const candidate = context.candidateExtensions?.[0] ?? ".dart";
      const normalized = candidate.startsWith(".") ? candidate : `.${candidate}`;
      return `${trimmed}${normalized}`;
    }

    return trimmed;
  }
}

export function createDartAdapter(options: DartAdapterOptions = {}): DartAdapter {
  return new DartAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): DartParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".dart" ? "dart" : null;
}
