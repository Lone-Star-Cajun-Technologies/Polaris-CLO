import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractCSharpSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type CSharpParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".cs"] as const;

export interface CSharpAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class CSharpAdapter implements LanguageAdapter {
  readonly languageId = "csharp";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (classes, methods, static methods, using directives).",
    "Does not perform generic type or semantic symbol resolution.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported C# file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractCSharpSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createCSharpAdapter(options: CSharpAdapterOptions = {}): CSharpAdapter {
  return new CSharpAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): CSharpParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".cs" ? "csharp" : null;
}
