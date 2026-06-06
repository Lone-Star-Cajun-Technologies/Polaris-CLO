import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractGoSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type GoParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".go"] as const;

export interface GoAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class GoAdapter implements LanguageAdapter {
  readonly languageId = "go";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (structs/interfaces, functions, methods, imports).",
    "Does not perform package/module resolution or call/reference extraction.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported Go file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractGoSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createGoAdapter(options: GoAdapterOptions = {}): GoAdapter {
  return new GoAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): GoParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".go" ? "go" : null;
}
