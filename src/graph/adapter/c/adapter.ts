import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractCSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type CParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".c", ".h"] as const;

export interface CAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class CAdapter implements LanguageAdapter {
  readonly languageId = "c";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (functions, structs, includes).",
    "Does not perform macro expansion or preprocessor execution.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported C file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractCSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createCAdapter(options: CAdapterOptions = {}): CAdapter {
  return new CAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): CParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".c" || extension === ".h" ? "c" : null;
}
