import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractSwiftSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type SwiftParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".swift"] as const;

export interface SwiftAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class SwiftAdapter implements LanguageAdapter {
  readonly languageId = "swift";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "medium" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (classes/structs/protocols, functions/methods, imports).",
    "Uses tree-sitter-swift@0.7.x; newer Swift constructs (including async/await nuance and macro declarations) are deferred.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported Swift file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractSwiftSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createSwiftAdapter(options: SwiftAdapterOptions = {}): SwiftAdapter {
  return new SwiftAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): SwiftParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".swift" ? "swift" : null;
}
