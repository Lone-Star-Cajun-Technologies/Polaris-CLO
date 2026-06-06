import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractKotlinSymbolsFromTree } from "./kotlin-extract.js";
import { loadTreeSitterRuntime, type KotlinJavaParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".kt", ".kts"] as const;

export interface KotlinAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class KotlinAdapter implements LanguageAdapter {
  readonly languageId = "kotlin";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "medium" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (classes/objects, functions/methods, imports).",
    "Uses tree-sitter-kotlin@0.3.x; newer language constructs may parse incompletely until grammar updates.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported Kotlin file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractKotlinSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createKotlinAdapter(options: KotlinAdapterOptions = {}): KotlinAdapter {
  return new KotlinAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): KotlinJavaParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".kt" || extension === ".kts") {
    return "kotlin";
  }
  return null;
}
