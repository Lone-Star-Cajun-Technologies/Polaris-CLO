import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractJavaSymbolsFromTree } from "./java-extract.js";
import { loadTreeSitterRuntime, type KotlinJavaParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".java"] as const;

export interface JavaAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class JavaAdapter implements LanguageAdapter {
  readonly languageId = "java";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (classes/interfaces, methods, imports).",
    "Does not resolve overloads, inherited methods, or semantic type relationships.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported Java file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractJavaSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createJavaAdapter(options: JavaAdapterOptions = {}): JavaAdapter {
  return new JavaAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): KotlinJavaParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".java" ? "java" : null;
}
