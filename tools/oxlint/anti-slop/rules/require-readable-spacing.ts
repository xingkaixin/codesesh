import type { CreateRule } from "@oxlint/plugins";

import createPaddingLineRule from "../vendor/eslint-stylistic/padding-line-between-statements.ts";

const declarations = {
  selector: "Program > :matches(FunctionDeclaration, ClassDeclaration, TSInterfaceDeclaration, TSTypeAliasDeclaration, ExportNamedDeclaration[declaration.type=/^(FunctionDeclaration|ClassDeclaration|TSInterfaceDeclaration|TSTypeAliasDeclaration)$/], ExportDefaultDeclaration[declaration.type=/^(FunctionDeclaration|ClassDeclaration)$/])",
};

const paddingRule = createPaddingLineRule([
  { blankLine: "always", prev: "import", next: "*" },
  { blankLine: "always", prev: "*", next: declarations },
  { blankLine: "always", prev: declarations, next: "*" },
  { blankLine: "any", prev: "import", next: "import" },
  {
    blankLine: "any",
    prev: {
      selector:
        ':matches(TSDeclareFunction, ExportNamedDeclaration[declaration.type="TSDeclareFunction"])',
    },
    next: {
      selector:
        ':matches(TSDeclareFunction, FunctionDeclaration, ExportNamedDeclaration[declaration.type="TSDeclareFunction"], ExportNamedDeclaration[declaration.type="FunctionDeclaration"])',
    },
  },
]);

/** Separate module declarations without splitting function-local statement groups. */
export const requireReadableSpacingRule: CreateRule = {
  ...paddingRule,
  meta: {
    ...paddingRule.meta,
    docs: {
      description: "Separate imports and module declarations while preserving local statement groups.",
    },
    schema: [],
  },
};
