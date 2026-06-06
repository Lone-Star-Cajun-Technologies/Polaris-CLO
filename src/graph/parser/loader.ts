export type SupportedParserLanguage = "typescript" | "javascript";

export interface SyntaxPoint {
  row: number;
  column: number;
}

export interface SyntaxNodeLike {
  type: string;
  text: string;
  startPosition: SyntaxPoint;
  endPosition: SyntaxPoint;
  namedChildren?: SyntaxNodeLike[];
  childForFieldName?(fieldName: string): SyntaxNodeLike | null;
  parent?: SyntaxNodeLike | null;
}

export interface ParseTreeLike {
  rootNode: SyntaxNodeLike;
}

export interface ParserInstanceLike {
  setLanguage(language: unknown): void;
  parse(source: string): ParseTreeLike;
}

interface ParserConstructorLike {
  new (): ParserInstanceLike;
}

export interface TreeSitterRuntime {
  parse(source: string, language: SupportedParserLanguage): ParseTreeLike;
}

interface LoadedTreeSitter {
  parserConstructor: ParserConstructorLike;
  languages: Record<SupportedParserLanguage, unknown>;
}

let cachedRuntime: TreeSitterRuntime | null = null;

export async function loadTreeSitterRuntime(): Promise<TreeSitterRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const loaded = await loadTreeSitterModules();
  const parserByLanguage = new Map<SupportedParserLanguage, ParserInstanceLike>();

  cachedRuntime = {
    parse(source, language) {
      const parser = getOrCreateParser(language, loaded, parserByLanguage);
      return parser.parse(source);
    },
  };

  return cachedRuntime;
}

function getOrCreateParser(
  language: SupportedParserLanguage,
  loaded: LoadedTreeSitter,
  parserByLanguage: Map<SupportedParserLanguage, ParserInstanceLike>,
): ParserInstanceLike {
  const existing = parserByLanguage.get(language);
  if (existing) {
    return existing;
  }

  const parser = new loaded.parserConstructor();
  const grammar = loaded.languages[language];
  parser.setLanguage(grammar);
  parserByLanguage.set(language, parser);
  return parser;
}

async function loadTreeSitterModules(): Promise<LoadedTreeSitter> {
  const dynamicImport = createDynamicImporter();
  const [treeSitterModule, typeScriptModule, javaScriptModule] = await Promise.all([
    dynamicImport("tree-sitter"),
    dynamicImport("@tree-sitter/typescript"),
    dynamicImport("@tree-sitter/javascript"),
  ]);

  const parserConstructor = resolveParserConstructor(treeSitterModule);
  const typeScriptGrammar = resolveTypeScriptGrammar(typeScriptModule);
  const javaScriptGrammar = resolveJavaScriptGrammar(javaScriptModule);

  return {
    parserConstructor,
    languages: {
      typescript: typeScriptGrammar,
      javascript: javaScriptGrammar,
    },
  };
}

function createDynamicImporter(): (specifier: string) => Promise<unknown> {
  const importer = new Function("specifier", "return import(specifier);");
  return (specifier: string) => importer(specifier) as Promise<unknown>;
}

function resolveParserConstructor(moduleValue: unknown): ParserConstructorLike {
  if (typeof moduleValue === "function") {
    return moduleValue as ParserConstructorLike;
  }

  if (moduleValue && typeof moduleValue === "object") {
    const directDefault = (moduleValue as { default?: unknown }).default;
    if (typeof directDefault === "function") {
      return directDefault as ParserConstructorLike;
    }
    const namedParser = (moduleValue as { Parser?: unknown }).Parser;
    if (typeof namedParser === "function") {
      return namedParser as ParserConstructorLike;
    }
  }

  throw new Error("Unable to resolve tree-sitter parser constructor.");
}

function resolveTypeScriptGrammar(moduleValue: unknown): unknown {
  if (moduleValue && typeof moduleValue === "object") {
    const direct = moduleValue as { typescript?: unknown; default?: { typescript?: unknown } | unknown };
    if (direct.typescript) {
      return direct.typescript;
    }
    if (direct.default && typeof direct.default === "object" && "typescript" in direct.default) {
      return (direct.default as { typescript?: unknown }).typescript;
    }
    if (direct.default) {
      return direct.default;
    }
  }

  throw new Error("Unable to resolve @tree-sitter/typescript grammar.");
}

function resolveJavaScriptGrammar(moduleValue: unknown): unknown {
  if (moduleValue && typeof moduleValue === "object") {
    const direct = moduleValue as { javascript?: unknown; default?: { javascript?: unknown } | unknown };
    if (direct.javascript) {
      return direct.javascript;
    }
    if (direct.default && typeof direct.default === "object" && "javascript" in direct.default) {
      return (direct.default as { javascript?: unknown }).javascript;
    }
    if (direct.default) {
      return direct.default;
    }
  }

  throw new Error("Unable to resolve @tree-sitter/javascript grammar.");
}
