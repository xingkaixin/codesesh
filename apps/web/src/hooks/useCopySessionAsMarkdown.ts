import { t } from "../i18n/translate";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { fetchSessionData, logClientEvent, type SessionHead } from "../lib/api";
import { writeToClipboard } from "../lib/clipboard";
import { queryKeys } from "../lib/query-keys";
import { formatSessionAsMarkdown } from "../lib/session-markdown";

const COPY_NOTICE_DURATION_MS = 2_500;

export function useCopySessionAsMarkdown() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ message: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), COPY_NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const copySessionAsMarkdown = useCallback(
    async (sessionHead: SessionHead) => {
      const { agentName, sessionId, sourceNodeId } = sessionHead.reference;
      try {
        let detail = await queryClient.fetchQuery({
          queryKey: queryKeys.sessionDetail(agentName, sessionId, sourceNodeId),
          queryFn: ({ signal }) =>
            fetchSessionData(agentName, sessionId, {
              signal,
              ...(sourceNodeId ? { sourceNodeId } : {}),
            }),
          staleTime: Infinity,
        });
        if (detail.messages.length < (detail.message_total ?? detail.messages.length)) {
          detail = await fetchSessionData(agentName, sessionId, { sourceNodeId });
        }
        const copied = await writeToClipboard(formatSessionAsMarkdown(detail));
        if (!copied) throw new Error("Clipboard write failed");
        setNotice({ message: "Session copied as Markdown." });
        logClientEvent("session.markdown_copy.done", { agent: agentName, session: sessionId });
      } catch (error) {
        setNotice({ message: "Couldn’t copy session as Markdown." });
        logClientEvent("session.markdown_copy.error", {
          agent: agentName,
          session: sessionId,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      }
    },
    [queryClient],
  );

  return { copySessionAsMarkdown, sessionCopyNotice: notice ? t(notice.message) : null };
}
