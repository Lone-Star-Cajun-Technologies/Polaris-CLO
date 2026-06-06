import type { AdapterExtractionResult, ExtractedSymbol } from "../types.js";
import type { ParseTreeLike, SyntaxNodeLike } from "../../parser/loader.js";
import { createSymbol, dedupeAndSortSymbols, extractDeclaredName, sanitizeSignature, walkNodes } from "./extract-common.js";

export function extractJavaSymbolsFromTree(tree: ParseTreeLike): AdapterExtractionResult {
  const symbols: ExtractedSymbol[] = [];

  walkNodes(tree.rootNode, (node) => {
    const symbol = toExtractedSymbol(node);
    if (symbol) {
      symbols.push(symbol);
    }
  });

  return {
    language: "java",
    symbols: dedupeAndSortSymbols(symbols),
  };
}

function toExtractedSymbol(node: SyntaxNodeLike): ExtractedSymbol | null {
  if (node.type === "import_declaration") {
    return createSymbol(node, "import", extractImportName(node), null, false);
  }

  if (node.type === "class_declaration" || node.type === "interface_declaration") {
    return createSymbol(node, "class", extractTypeName(node), null, isPublic(node.text));
  }

  if (node.type === "method_declaration") {
    return createSymbol(node, "method", extractMethodName(node), sanitizeSignature(node.text), isPublic(node.text));
  }

  return null;
}

function extractTypeName(node: SyntaxNodeLike): string | null {
  return extractDeclaredName(node, IDENTIFIER_NODE_TYPES, /\b(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/);
}

function extractMethodName(node: SyntaxNodeLike): string | null {
  return extractDeclaredName(node, IDENTIFIER_NODE_TYPES, /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
}

function extractImportName(node: SyntaxNodeLike): string | null {
  return node.text.match(/^\s*import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.$]*(?:\.\*)?)\s*;/m)?.[1] ?? null;
}

function isPublic(text: string): boolean {
  return /\bpublic\b/.test(text);
}

const IDENTIFIER_NODE_TYPES = new Set(["identifier", "type_identifier"]);
