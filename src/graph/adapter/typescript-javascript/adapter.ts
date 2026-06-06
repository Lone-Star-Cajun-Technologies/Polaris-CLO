import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractTypeScriptJavaScriptSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type TreeSitterRuntime, type TypeScriptJavaScriptParserLanguage } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

export interface TypeScriptJavaScriptAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class TypeScriptJavaScriptAdapter implements LanguageAdapter {
  readonly languageId = "typescript-javascript";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (functions, classes, methods, imports).",
    "Does not resolve runtime module graph semantics beyond extension normalization.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported TypeScript/JavaScript file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractTypeScriptJavaScriptSymbolsFromTree(tree, language);
  }

  resolveImportSpecifier(specifier: string, context: ImportResolutionContext): string | null {
    if (specifier.length === 0) {
      return null;
    }

    if (!specifier.startsWith(".")) {
      return specifier;
    }

    if (extname(specifier).length > 0) {
      return specifier;
    }

    const candidateExtensions = context.candidateExtensions?.length
      ? context.candidateExtensions
      : [preferredExtensionForFile(context.fromFilePath)];
    return `${specifier}${candidateExtensions[0]}`;
  }
}

export function createTypeScriptJavaScriptAdapter(
  options: TypeScriptJavaScriptAdapterOptions = {},
): TypeScriptJavaScriptAdapter {
  return new TypeScriptJavaScriptAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): TypeScriptJavaScriptParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") {
    return "typescript";
  }
  if (
    extension === ".js" ||
    extension === ".jsx" ||
    extension === ".mjs" ||
    extension === ".cjs"
  ) {
    return "javascript";
  }
  return null;
}

function preferredExtensionForFile(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") {
    return ".ts";
  }
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    return ".js";
  }
  return ".ts";
}
