import type { SessionHead } from "../../lib/api";
import { ModelConfig } from "../../config";
import { getSessionAgentKey } from "../../lib/session-indexes";
import { formatRelativeTime } from "../../lib/format";
import { getSessionDisplayTitle } from "../../lib/session-title";
import { SessionActionsMenu } from "../SessionActionsMenu";

export function SidebarFlatSessionList({
  sessions,
  activeSessionId,
  selectedSessionId,
  bookmarkedSessionIds,
  onSelectSession,
  onToggleBookmark,
  onRenameSession,
}: {
  sessions: SessionHead[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  bookmarkedSessionIds: Set<string>;
  onSelectSession: (session: SessionHead) => void;
  onToggleBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
}) {
  return (
    <div className="console-scrollbar h-[min(560px,calc(100vh-410px))] min-h-56 overflow-y-auto">
      <ul className="space-y-1">
        {sessions.map((sessionItem) => {
          const agentKey = getSessionAgentKey(sessionItem);
          const agentConfig = ModelConfig.agents[agentKey];
          const active = activeSessionId === sessionItem.id;
          const selected = selectedSessionId === sessionItem.id;
          return (
            <li key={sessionItem.slug}>
              <div
                className={`flex items-start gap-1 rounded-sm border px-2 py-1.5 transition-colors ${
                  active || selected
                    ? "border-[var(--console-border-strong)] bg-white text-[var(--console-text)]"
                    : "border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectSession(sessionItem)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {agentConfig?.icon ? (
                      <img
                        src={agentConfig.icon}
                        alt={agentConfig.name}
                        className="size-3.5 shrink-0 object-contain"
                      />
                    ) : null}
                    <span className="console-mono line-clamp-1 text-xs text-[var(--console-text)]">
                      {getSessionDisplayTitle(sessionItem)}
                    </span>
                  </span>
                  <span className="console-mono mt-0.5 block truncate text-[10px] text-[var(--console-muted)]">
                    {formatRelativeTime(sessionItem.time_updated ?? sessionItem.time_created)}
                  </span>
                </button>
                <SessionActionsMenu
                  bookmarked={bookmarkedSessionIds.has(sessionItem.id)}
                  onRename={() => onRenameSession(sessionItem)}
                  onToggleBookmark={() => onToggleBookmark(sessionItem)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
