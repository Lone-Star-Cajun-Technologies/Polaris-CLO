import type { ParseTreeLike } from "../../parser/loader.js";

export type KotlinJavaParserLanguage = "java" | "kotlin";

export interface ParserInstanceLike {
  setLanguage(language: unknown): void;
  parse(source: string): ParseTreeLike;
}

interface ParserConstructorLike {
  new (): ParserInstanceLike;
}

export interface TreeSitterRuntime {
  parse(source: string, language: KotlinJavaParserLanguage): ParseTreeLike;
}

interface LoadedTreeSitter {
  parserConstructor: ParserConstructorLike;
  languages: Record<KotlinJavaParserLanguage, unknown>;
}

let cachedRuntime: TreeSitterRuntime | null = null;

export async function loadTreeSitterRuntime(): Promise<TreeSitterRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const loaded = await loadTreeSitterModules();
  const parserByLanguage = new Map<KotlinJavaParserLanguage, ParserInstanceLike>();

  cachedRuntime = {
    parse(source, language) {
      const parser = getOrCreateParser(language, loaded, parserByLanguage);
      return parser.parse(source);
    },
  };

  return cachedRuntime;
}

function getOrCreateParser(
  language: KotlinJavaParserLanguage,
  loaded: LoadedTreeSitter,
  parserByLanguage: Map<KotlinJavaParserLanguage, ParserInstanceLike>,
): ParserInstanceLike {
  const existing = parserByLanguage.get(language);
  if (existing) {
    return existing;
  }

  const parser = new loaded.parserConstructor();
  parser.setLanguage(loaded.languages[language]);
  parserByLanguage.set(language, parser);
  return parser;
}

async function loadTreeSitterModules(): Promise<LoadedTreeSitter> {
  const dynamicImport = createDynamicImporter();
  const [treeSitterModule, javaModule, kotlinModule] = await Promise.all([
    dynamicImport("tree-sitter"),
    dynamicImport("tree-sitter-java"),
    dynamicImport("tree-sitter-kotlin"),
  ]);

  return {
    parserConstructor: resolveParserConstructor(treeSitterModule),
    languages: {
      java: resolveGrammar(javaModule, "tree-sitter-java"),
      kotlin: resolveGrammar(kotlinModule, "tree-sitter-kotlin"),
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

function resolveGrammar(moduleValue: unknown, packageName: string): unknown {
  if (moduleValue && typeof moduleValue === "object") {
    const directDefault = (moduleValue as { default?: unknown }).default;
    if (directDefault) {
      return directDefault;
    }
  }

  if (moduleValue) {
    return moduleValue;
  }

  throw new Error(`Unable to resolve ${packageName} grammar.`);
}
