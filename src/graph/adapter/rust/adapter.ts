import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractRustSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type RustParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".rs"] as const;

export interface RustAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class RustAdapter implements LanguageAdapter {
  readonly languageId = "rust";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (types, functions, impl methods, use declarations).",
    "Does not model lifetimes/generics as separate symbols or resolve call/reference edges.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported Rust file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractRustSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createRustAdapter(options: RustAdapterOptions = {}): RustAdapter {
  return new RustAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): RustParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".rs" ? "rust" : null;
}
