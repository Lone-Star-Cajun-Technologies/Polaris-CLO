import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractCppSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type CppParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".cpp", ".cc", ".cxx", ".hpp"] as const;

export interface CppAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class CppAdapter implements LanguageAdapter {
  readonly languageId = "cpp";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (classes, functions, methods, includes).",
    "Does not perform macro expansion or template instantiation.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported C++ file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractCppSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createCppAdapter(options: CppAdapterOptions = {}): CppAdapter {
  return new CppAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): CppParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".cpp" || extension === ".cc" || extension === ".cxx" || extension === ".hpp" ? "cpp" : null;
}
