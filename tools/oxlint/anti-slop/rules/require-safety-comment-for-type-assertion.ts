import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const DEFAULT_SAFETY_MARKERS = ["SAFETY"] as const;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function configuredSafetyMarkers(option: unknown): readonly string[] {
  if (typeof option !== "object" || option === null || !("markers" in option)) {
    return DEFAULT_SAFETY_MARKERS;
  }
  const configured = option.markers;
  if (!Array.isArray(configured)) return DEFAULT_SAFETY_MARKERS;
  const markers = configured.flatMap((marker) =>
    typeof marker === "string" && marker.trim().length > 0 ? [marker.trim()] : [],
  );
  return markers.length > 0 ? markers : DEFAULT_SAFETY_MARKERS;
}

function markerPattern(markers: readonly string[]): RegExp {
  const alternation = markers
    .map((marker) => marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join("|");
  return new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:${alternation})\s*:\s*\S`,
    "u",
  );
}

function hasSafetyJustificationBefore(
  sourceCode: SourceCode,
  owner: ESTree.Node,
  assertion: TypeAssertion,
  pattern: RegExp,
): boolean {
  return sourceCode
    .getCommentsBefore(owner)
    .some(
      (comment) => comment.end <= assertion.start && pattern.test(comment.value),
    );
}

function hasSafetyComment(
  sourceCode: SourceCode,
  node: TypeAssertion,
  pattern: RegExp,
): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (hasSafetyJustificationBefore(sourceCode, current, node, pattern)) return true;
    if (commentOwnerKinds.has(current.type)) {
      const exportDeclaration = current.parent;
      return (
        exportDeclaration.type === "ExportNamedDeclaration" &&
        exportDeclaration.declaration === current &&
        hasSafetyJustificationBefore(sourceCode, exportDeclaration, node, pattern)
      );
    }
    if (current.parent.type === "Program") return false;
    current = current.parent;
  }
}

/** Require configured type assertions to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for configured TypeScript assertions; const assertions are exempt.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `{{marker}}:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
    schema: [
      {
        type: "object",
        properties: {
          scope: { enum: ["all", "type-escapes"] },
          markers: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ markers: ["SAFETY"] }],
  },
  createOnce(context) {
    const patterns = new Map<string, RegExp>();

    const containsTypeEscape = (node: ESTree.Node): boolean => {
      if (node.type === "TSAnyKeyword" || node.type === "TSNeverKeyword") return true;
      for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
        // SAFETY: Oxlint visitor keys enumerate AST child properties, never metadata or parent links.
        const child = (node as unknown as Record<string, ESTree.Node | ESTree.Node[] | null>)[key];
        if (Array.isArray(child) ? child.some(containsTypeEscape) : child && containsTypeEscape(child)) return true;
      }
      return false;
    };

    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      const option = context.options?.[0];
      if (typeof option === "object" && option !== null && !Array.isArray(option) && option.scope === "type-escapes") {
        let expression = node.expression;
        while (expression.type === "ParenthesizedExpression") expression = expression.expression;
        const chain = expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion";
        if (!chain && !containsTypeEscape(node.typeAnnotation)) return;
      }
      const markers = configuredSafetyMarkers(option);
      const patternKey = markers.join("\u0000");
      const pattern = patterns.get(patternKey) ?? markerPattern(markers);
      patterns.set(patternKey, pattern);
      if (hasSafetyComment(context.sourceCode, node, pattern)) return;
      context.report({
        node,
        messageId: "missingSafetyComment",
        data: { marker: markers[0] ?? DEFAULT_SAFETY_MARKERS[0] },
      });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
