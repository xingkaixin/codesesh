import { useNodes, useNodeClock } from "../../hooks/useNodes";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";
import { sourceName } from "./SourceBadge";
import { nodeStatus } from "./node-status";

const MESSAGES = {
  "Run this command on {0}, in a POSIX-compatible shell.": [
    "请在来源机器 {0} 上使用兼容 POSIX 的终端执行此命令。",
    "接続元の {0} で、POSIX 互換シェルを使用してこのコマンドを実行してください。",
  ],
  "Run this command on the machine running CodeSesh, in a POSIX-compatible shell.": [
    "请在运行 CodeSesh 的机器上使用兼容 POSIX 的终端执行此命令。",
    "CodeSesh を実行しているマシンで、POSIX 互換シェルを使用してこのコマンドを実行してください。",
  ],
  "Source last synced: {0}": ["来源最近同步：{0}", "接続元の最終同期：{0}"],
  "No source sync confirmed yet": ["尚无已确认的来源同步", "接続元の同期はまだ確認されていません"],
} as const;

export function SessionSourceDetails({
  sourceNodeId,
  canResume,
  resumeDescriptionId,
}: {
  sourceNodeId: string;
  canResume: boolean;
  resumeDescriptionId: string;
}) {
  const locale = useLocale();
  const nodes = useNodes();
  const now = useNodeClock();
  const remote = sourceNodeId !== "local";
  const node = nodes.data?.nodes.find((item) => item.id === sourceNodeId);

  if (!remote) {
    // The hero eyebrow already names the local source; the hint only describes the resume button.
    return canResume ? (
      <p id={resumeDescriptionId} className="sr-only">
        {t(
          "Run this command on the machine running CodeSesh, in a POSIX-compatible shell.",
          [],
          locale,
          MESSAGES,
        )}
      </p>
    ) : null;
  }

  return (
    <div className="mt-2 space-y-1 text-xs leading-5 text-[var(--console-muted)]">
      {canResume && (
        <p id={resumeDescriptionId} className="break-words">
          {t(
            "Run this command on {0}, in a POSIX-compatible shell.",
            [sourceName(sourceNodeId, nodes.data?.nodes)],
            locale,
            MESSAGES,
          )}
        </p>
      )}
      <p>{t("Paths belong to the source machine. Files are not transferred.")}</p>
      <p>
        {nodes.isError || !node ? t("Node status unavailable") : nodeStatus(node, now)}
        {node && (
          <>
            {" · "}
            {node.lastConfirmedAt != null
              ? t(
                  "Source last synced: {0}",
                  [new Date(node.lastConfirmedAt).toLocaleString(locale)],
                  locale,
                  MESSAGES,
                )
              : t("No source sync confirmed yet", [], locale, MESSAGES)}
          </>
        )}
      </p>
    </div>
  );
}
