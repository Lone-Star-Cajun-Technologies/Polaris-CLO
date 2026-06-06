import { extname } from "node:path";
import type { AdapterExtractionResult, ImportResolutionContext, LanguageAdapter } from "../types.js";
import { extractPythonSymbolsFromTree } from "./extract.js";
import { loadTreeSitterRuntime, type PythonParserLanguage, type TreeSitterRuntime } from "./runtime.js";

const DEFAULT_EXTENSIONS = [".py", ".pyi"] as const;

export interface PythonAdapterOptions {
  loadRuntime?: () => Promise<TreeSitterRuntime>;
}

export class PythonAdapter implements LanguageAdapter {
  readonly languageId = "python";

  readonly fileExtensions = DEFAULT_EXTENSIONS;

  readonly confidence = "high" as const;

  readonly limitations = [
    "Extracts declaration-level symbols only (classes, functions, methods, imports).",
    "Does not perform runtime import resolution or call/reference extraction.",
  ] as const;

  constructor(private readonly loadRuntime: () => Promise<TreeSitterRuntime>) {}

  async extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult> {
    const language = detectLanguage(filePath);
    if (!language) {
      throw new Error(`Unsupported Python file extension: ${extname(filePath)}`);
    }

    const runtime = await this.loadRuntime();
    const tree = runtime.parse(source, language);
    return extractPythonSymbolsFromTree(tree);
  }

  resolveImportSpecifier(specifier: string, _context: ImportResolutionContext): string | null {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed;
  }
}

export function createPythonAdapter(options: PythonAdapterOptions = {}): PythonAdapter {
  return new PythonAdapter(options.loadRuntime ?? loadTreeSitterRuntime);
}

function detectLanguage(filePath: string): PythonParserLanguage | null {
  const extension = extname(filePath).toLowerCase();
  return extension === ".py" || extension === ".pyi" ? "python" : null;
}
