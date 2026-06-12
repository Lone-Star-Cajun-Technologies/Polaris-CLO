import type { ParseTreeLike } from "../../parser/loader.js";

export type CParserLanguage = "c";

export interface ParserInstanceLike {
  setLanguage(language: unknown): void;
  parse(source: string): ParseTreeLike;
}

interface ParserConstructorLike {
  new (): ParserInstanceLike;
}

export interface TreeSitterRuntime {
  parse(source: string, language: CParserLanguage): ParseTreeLike;
}

interface LoadedTreeSitter {
  parserConstructor: ParserConstructorLike;
  language: unknown;
}

let cachedRuntime: TreeSitterRuntime | null = null;
let cachedRuntimePromise: Promise<TreeSitterRuntime> | null = null;

export async function loadTreeSitterRuntime(): Promise<TreeSitterRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  if (cachedRuntimePromise) {
    return await cachedRuntimePromise;
  }

  cachedRuntimePromise = (async () => {
    const loaded = loadTreeSitterModules();
    const parser = new loaded.parserConstructor();
    parser.setLanguage(loaded.language);

    const runtime: TreeSitterRuntime = {
      parse(source) {
        return parser.parse(source);
      },
    };

    cachedRuntime = runtime;
    cachedRuntimePromise = null;
    return runtime;
  })();

  return await cachedRuntimePromise;
}

function loadTreeSitterModules(): LoadedTreeSitter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeRequire = require as (id: string) => unknown;
  const [treeSitterModule, cModule] = [nodeRequire("tree-sitter"), nodeRequire("tree-sitter-c")];

  return {
    parserConstructor: resolveParserConstructor(treeSitterModule),
    language: resolveGrammar(cModule, "tree-sitter-c"),
  };
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
