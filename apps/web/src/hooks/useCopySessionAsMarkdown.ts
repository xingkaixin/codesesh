import { t } from "../i18n/translate";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useState } from "react";
import type { SessionDetail, SessionHead } from "@codesesh/contract";
import { fetchSessionData, logClientEvent } from "../lib/api";
import { writeToClipboard } from "../lib/clipboard";
import { downloadTextFile } from "../lib/download";
import { queryKeys } from "../lib/query-keys";
import { pruneSessionDetailCache } from "../lib/session-detail-cache";
import { buildSessionMarkdownFilename, formatSessionAsMarkdown } from "../lib/session-markdown";

const COPY_NOTICE_DURATION_MS = 2_500;

function isCompleteSessionDetail(session: SessionHead | SessionDetail): session is SessionDetail {
  if (!("messages" in session) || !Array.isArray(session.messages)) return false;
  return session.messages.length >= (session.message_total ?? session.messages.length);
}

async function resolveCompleteSessionDetail(
  queryClient: QueryClient | undefined,
  sessionHead: SessionHead | SessionDetail,
): Promise<SessionDetail> {
  if (isCompleteSessionDetail(sessionHead)) return sessionHead;
  const { agentName, sessionId, sourceNodeId } = sessionHead.reference;
  let detail = queryClient
    ? await queryClient.fetchQuery({
        queryKey: queryKeys.sessionDetail(agentName, sessionId, sourceNodeId),
        queryFn: ({ signal }) =>
          fetchSessionData(agentName, sessionId, {
            signal,
            ...(sourceNodeId ? { sourceNodeId } : {}),
          }),
        staleTime: Infinity,
      })
    : await fetchSessionData(agentName, sessionId, sourceNodeId ? { sourceNodeId } : {});
  if (detail.messages.length < (detail.message_total ?? detail.messages.length)) {
    detail = await fetchSessionData(agentName, sessionId, { sourceNodeId });
  }
  return detail;
}

export function useCopySessionAsMarkdown() {
  const queryClient = useContext(QueryClientContext);
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const [pendingCopies, setPendingCopies] = useState(0);
  const [pendingDownloads, setPendingDownloads] = useState(0);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), COPY_NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const copySessionAsMarkdown = useCallback(
    async (sessionHead: SessionHead | SessionDetail) => {
      const { agentName, sessionId } = sessionHead.reference;
      setPendingCopies((count) => count + 1);
      try {
        const markdownPromise = (async () => {
          const detail = await resolveCompleteSessionDetail(queryClient, sessionHead);
          return formatSessionAsMarkdown(detail);
        })();
        // Prevent unhandled rejections if the ClipboardItem path fails before fallback await.
        void markdownPromise.catch(() => {});

        let copied = false;
        // Bind the clipboard write synchronously to the user gesture via a Promise<Blob>
        // so Safari and Firefox keep transient activation while extra pages load.
        if (
          typeof navigator !== "undefined" &&
          typeof ClipboardItem !== "undefined" &&
          typeof navigator.clipboard?.write === "function"
        ) {
          try {
            const blobPromise = markdownPromise.then(
              (markdown) => new Blob([markdown], { type: "text/plain" }),
            );
            await navigator.clipboard.write([new ClipboardItem({ "text/plain": blobPromise })]);
            await markdownPromise;
            copied = true;
          } catch {
            // Fall through to writeToClipboard below if ClipboardItem/write is unsupported or rejected.
          }
        }

        if (!copied) {
          const markdown = await markdownPromise;
          copied = await writeToClipboard(markdown);
        }

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
      } finally {
        setPendingCopies((count) => Math.max(0, count - 1));
        if (queryClient) pruneSessionDetailCache(queryClient);
      }
    },
    [queryClient],
  );

  const downloadSessionAsMarkdown = useCallback(
    async (sessionHead: SessionHead | SessionDetail) => {
      const { agentName, sessionId } = sessionHead.reference;
      setPendingDownloads((count) => count + 1);
      try {
        const detail = await resolveCompleteSessionDetail(queryClient, sessionHead);
        const markdown = formatSessionAsMarkdown(detail);
        const filename = buildSessionMarkdownFilename(detail);
        const downloaded = downloadTextFile(filename, markdown);
        if (!downloaded) throw new Error("Markdown download failed");
        setNotice({ message: "Session downloaded as Markdown." });
        logClientEvent("session.markdown_download.done", { agent: agentName, session: sessionId });
      } catch (error) {
        setNotice({ message: "Couldn’t download session as Markdown." });
        logClientEvent("session.markdown_download.error", {
          agent: agentName,
          session: sessionId,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        setPendingDownloads((count) => Math.max(0, count - 1));
        if (queryClient) pruneSessionDetailCache(queryClient);
      }
    },
    [queryClient],
  );

  return {
    copySessionAsMarkdown,
    downloadSessionAsMarkdown,
    isCopying: pendingCopies > 0,
    isDownloading: pendingDownloads > 0,
    sessionCopyNotice: notice ? t(notice.message) : null,
  };
}
