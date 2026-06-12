import type { ParseTreeLike } from "../../parser/loader.js";

export type PythonParserLanguage = "python";

export interface ParserInstanceLike {
  setLanguage(language: unknown): void;
  parse(source: string): ParseTreeLike;
}

interface ParserConstructorLike {
  new (): ParserInstanceLike;
}

export interface TreeSitterRuntime {
  parse(source: string, language: PythonParserLanguage): ParseTreeLike;
}

interface LoadedTreeSitter {
  parserConstructor: ParserConstructorLike;
  language: unknown;
}

let cachedRuntime: TreeSitterRuntime | null = null;
let runtimeInitPromise: Promise<TreeSitterRuntime> | null = null;

export async function loadTreeSitterRuntime(): Promise<TreeSitterRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  if (runtimeInitPromise) {
    return await runtimeInitPromise;
  }

  runtimeInitPromise = (async () => {
    const loaded = loadTreeSitterModules();
    const parser = new loaded.parserConstructor();
    parser.setLanguage(loaded.language);

    const runtime: TreeSitterRuntime = {
      parse(source) {
        return parser.parse(source);
      },
    };

    cachedRuntime = runtime;
    runtimeInitPromise = null;
    return runtime;
  })();

  return await runtimeInitPromise;
}

function loadTreeSitterModules(): LoadedTreeSitter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeRequire = require as (id: string) => unknown;
  const [treeSitterModule, pythonModule] = [
    nodeRequire("tree-sitter"),
    nodeRequire("tree-sitter-python"),
  ];

  return {
    parserConstructor: resolveParserConstructor(treeSitterModule),
    language: resolveGrammar(pythonModule, "tree-sitter-python"),
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
