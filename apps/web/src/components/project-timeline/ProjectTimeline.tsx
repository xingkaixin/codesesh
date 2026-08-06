/**
 * Screen 2a — the project timeline. Sessions are grouped by calendar day and
 * every sub-session stays inside its parent's card, so the day axis only ever
 * carries top-level work.
 */
import { useCallback, useMemo, useState } from "react";
import type { SessionHead, SessionReference } from "@codesesh/core/contract";
import type { AgentCatalog } from "../../lib/agents";
import { formatCompact } from "../../lib/format";
import { buildProjectTimeline, type SubSessionMode } from "../../lib/session-timeline";
import { SubSessionModeSwitch } from "./sub-session-mode-switch";
import { TimelineDayGroup } from "./timeline-day-group";

export function ProjectTimeline({
  sessions,
  projectName,
  agentCatalog,
  onOpenSession,
}: {
  sessions: SessionHead[];
  projectName: string;
  agentCatalog: AgentCatalog;
  onOpenSession: (reference: SessionReference) => void;
}) {
  const [mode, setMode] = useState<SubSessionMode>("collapsed");
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const timeline = useMemo(() => buildProjectTimeline(sessions), [sessions]);

  // Mode changes deliberately leave openIds alone: 折叠 → 全部展开 → 折叠
  // must restore the rows the user had opened.
  const toggleRow = useCallback((routeKey: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (!next.delete(routeKey)) next.add(routeKey);
      return next;
    });
  }, []);

  return (
    <section aria-label={`${projectName} 时间线`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="console-mono text-[11px] text-[var(--console-muted)]">
          {`${timeline.mainCount} 主会话 · ${timeline.subCount} 子会话 · ${formatCompact(timeline.totalTokens)} tokens`}
        </span>
        <div className="ml-auto">
          <SubSessionModeSwitch mode={mode} onChange={setMode} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {timeline.days.map((day) => (
          <TimelineDayGroup
            key={day.dayKey}
            day={day}
            mode={mode}
            openIds={openIds}
            agentCatalog={agentCatalog}
            onToggle={toggleRow}
            onOpen={onOpenSession}
          />
        ))}
      </div>

      {timeline.orphanCount > 0 ? (
        <p className="console-mono text-[10.5px] text-[var(--console-muted)]">
          未挂载子会话 {timeline.orphanCount} · 父会话文件已不存在
        </p>
      ) : null}
    </section>
  );
}
