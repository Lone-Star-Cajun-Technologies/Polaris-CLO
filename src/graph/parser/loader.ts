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
