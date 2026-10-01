import { t } from "../../../i18n/translate";
import type { ToolPart } from "../../../lib/api";
import type { CodeExecutionToolOutputContent } from "../../tool-output/types";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  buildSemanticOutputContent,
  compactText,
  getOutputOrErrorText,
  joinToolText,
  toRecord,
  toStringValue,
  toDisplayText,
} from "../tool-normalize";
import { SquareTerminal } from "../../ui/icons";

export function buildCodeExecutionStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
  language: "javascript" | "typescript",
): ToolDisplayStrategy {
  const input = toRecord(state.inputValue);
  const description = compactText(input.description);
  const source =
    typeof state.inputValue === "string" ? state.inputValue : toStringValue(input.code);
  const value =
    state.status === "error" ? state.errorValue || state.outputValue : state.outputValue;
  const blocks = Array.isArray(value) ? value : [value];
  const output = blocks.flatMap<CodeExecutionToolOutputContent["output"][number]>((block) => {
    if (toRecord(block).type === "image") {
      const media = buildSemanticOutputContent([block]);
      return media?.kind === "media" ? [media] : [];
    }
    const text = joinToolText(block, false);
    const semantic = buildSemanticOutputContent(text || block);
    return semantic?.kind === "property-list"
      ? [semantic]
      : [{ kind: "plain", text: text || toDisplayText(block), language: "text", isCode: false }];
  });
  return {
    Icon: SquareTerminal,
    title: tool.tool,
    secondaryText:
      description ||
      (language === "javascript" ? t("Execute JavaScript") : t("Execute TypeScript")),
    details: [],
    expandable: true,
    showInputPreview: false,
    contentLabel: t("Execution output"),
    outputContent: {
      kind: "code-execution",
      source,
      language,
      failed: state.status === "error",
      output: output.length
        ? output
        : [{ kind: "plain", text: getOutputOrErrorText(state), language: "text", isCode: false }],
    },
  };
}
