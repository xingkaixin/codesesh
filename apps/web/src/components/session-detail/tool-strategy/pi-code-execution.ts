import { t } from "../../../i18n/translate";
import type { ToolPart } from "../../../lib/api";
import {
  type NormalizedToolState,
  type ToolDisplayStrategy,
  toRecord,
  toStringValue,
} from "../tool-normalize";
import { buildCodeExecutionStrategy } from "./code-execution";

export function buildPiCodeExecutionStrategy(
  tool: ToolPart,
  state: NormalizedToolState,
): ToolDisplayStrategy {
  const blocks = Array.isArray(state.outputValue) ? state.outputValue : [state.outputValue];
  const first = blocks[0];
  const text =
    typeof first === "string"
      ? first
      : toRecord(first).type === "text"
        ? toStringValue(toRecord(first).text)
        : "";
  const header = text.match(
    /^Script completed\r?\nWall time (\d+(?:\.\d+)?) seconds\r?\nOutput:\r?\n(?:\r?\n)?/,
  );
  const strategy = buildCodeExecutionStrategy(
    tool,
    header ? { ...state, outputValue: [text.slice(header[0].length), ...blocks.slice(1)] } : state,
    "javascript",
  );
  const metadata = toRecord(state.metadataValue);
  const calls = Array.isArray(metadata.calls)
    ? metadata.calls.map(toRecord).filter((call) => toStringValue(call.name))
    : [];
  const failures = calls.filter((call) => call.status === "error");
  return {
    ...strategy,
    secondaryText: failures.length
      ? `${strategy.secondaryText} · ${t("Internal call failures: {0}", [failures.length])}`
      : strategy.secondaryText,
    details: [
      ...(header ? [{ label: t("Wall time"), value: `${header[1]} s` }] : []),
      ...(Array.isArray(metadata.calls)
        ? [{ label: t("Internal calls"), value: String(calls.length) }]
        : []),
      ...failures.map((call) => ({
        label: t("Internal call failed"),
        value: `${toStringValue(call.name)}: ${toStringValue(call.error).split(/\r?\n/)[0]}`,
      })),
    ],
  };
}
