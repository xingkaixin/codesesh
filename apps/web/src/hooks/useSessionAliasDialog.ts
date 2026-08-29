import { useCallback, useState } from "react";
import type { SessionAliasTarget } from "../components/SessionAliasDialog";
import type { BookmarkView, SessionHead } from "../lib/api";
import { getSessionAgentKey } from "../lib/session-indexes";
import { useSessionAliasMutations } from "./useSessionAliasMutations";

export function useSessionAliasDialog(refreshViews: () => Promise<void>) {
  const [target, setTarget] = useState<SessionAliasTarget | null>(null);
  const { saveAlias, removeAlias } = useSessionAliasMutations(refreshViews);

  const openSession = useCallback((session: SessionHead) => {
    setTarget({
      agentKey: getSessionAgentKey(session),
      sessionId: session.reference.sessionId,
      title: session.title,
      displayTitle: session.display_title,
    });
  }, []);

  const openBookmark = useCallback((bookmark: BookmarkView) => {
    setTarget({
      agentKey: bookmark.reference.agentName,
      sessionId: bookmark.reference.sessionId,
      title:
        bookmark.availability === "available"
          ? bookmark.session.title
          : bookmark.reference.sessionId,
      displayTitle:
        bookmark.availability === "available"
          ? bookmark.session.display_title
          : bookmark.display_title,
    });
  }, []);

  const save = useCallback(
    async (alias: string) => {
      if (target) await saveAlias(target, alias);
    },
    [saveAlias, target],
  );

  const remove = useCallback(async () => {
    if (target) await removeAlias(target);
  }, [removeAlias, target]);

  const close = useCallback(() => setTarget(null), []);

  return { target, openSession, openBookmark, save, remove, close };
}
