import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";
import {
  createSymbol,
  dedupeAndSortSymbols,
  extractDeclaredName,
  isMethodContext,
  sanitizeSignature,
  walkNodes,
} from "./extract-common.js";

export function extractKotlinSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];

  walkNodes(tree.rootNode, (node) => {
    const symbol = toExtractedSymbol(node);
    if (symbol) {
      symbols.push(symbol);
    }
  });

  return {
    language: "kotlin",
    symbols: dedupeAndSortSymbols(symbols),
  };
}

function toExtractedSymbol(node: SyntaxNodeLike): ExtractedSymbol | null {
  if (node.type === "import_header") {
    return createSymbol(node, "import", extractImportName(node), null, false);
  }

  if (node.type === "class_declaration" || node.type === "object_declaration") {
    return createSymbol(node, "class", extractTypeName(node), null, isExported(node.text));
  }

  if (node.type === "function_declaration") {
    const kind: ExtractedSymbol["kind"] = isMethodContext(node, METHOD_CONTAINER_NODE_TYPES) ? "method" : "function";
    return createSymbol(node, kind, extractFunctionName(node), sanitizeSignature(node.text), isExported(node.text));
  }

  return null;
}

function extractTypeName(node: SyntaxNodeLike): string | null {
  return extractDeclaredName(node, IDENTIFIER_NODE_TYPES, /\b(?:class|object)\s+([A-Za-z_][A-Za-z0-9_]*)/);
}

function extractFunctionName(node: SyntaxNodeLike): string | null {
  return extractDeclaredName(node, IDENTIFIER_NODE_TYPES, /\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
}

function extractImportName(node: SyntaxNodeLike): string | null {
  return node.text.match(/^\s*import\s+([A-Za-z_][A-Za-z0-9_.*]*)\b/m)?.[1] ?? null;
}

function isExported(text: string): boolean {
  return !/\b(?:private|internal|protected)\b/.test(text);
}

const IDENTIFIER_NODE_TYPES = new Set(["identifier", "simple_identifier", "type_identifier"]);
const METHOD_CONTAINER_NODE_TYPES = new Set([
  "class_declaration",
  "object_declaration",
  "class_body",
  "class_member_declarations",
  "companion_object",
]);
