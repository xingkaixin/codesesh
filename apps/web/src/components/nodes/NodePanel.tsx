import { useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import { isNodeOnline, useNodeClock, useNodes } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import { createPairingToken, setSourceIgnored } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import { Plug, Pencil } from "../ui/icons";
import { NodeDialog, nodeButton, nodePrimary } from "./NodeDialog";
import { NodeActions, type NodeAction } from "./NodeActions";
import { CollectionSources } from "../collection-status";
import { NodeTasks } from "./NodeTasks";
import {
  agentDisplayName,
  collectionStatus,
  hostSummary,
  missingSources,
  nodeNeedsAttention,
  nodeRecoveryHint,
  nodeStatus,
} from "./node-status";

export function NodePanel({ onClose }: { onClose: () => void }) {
  useLocale();
  const query = useNodes();
  const now = useNodeClock();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<NodeAction | null>(null);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState(false);
  const nodes = query.data?.nodes ?? [];
  const active = nodes.filter((node) => !node.revoked);
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0];
  const recoveryHint = selected ? nodeRecoveryHint(selected) : null;
  const toggleIgnored = async (nodeId: string, agent: string, ignored: boolean) => {
    setIgnoring(true);
    setError(null);
    try {
      await setSourceIgnored(nodeId, agent, ignored);
      await query.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Unable to update node."));
    } finally {
      setIgnoring(false);
    }
  };
  const pair = async () => {
    setPairing(true);
    setError(null);
    try {
      const value = await createPairingToken();
      setAction({
        kind: "pair",
        token: value.token,
        expires: Date.now() + value.expiresInSeconds * 1000,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Unable to update node."));
    } finally {
      setPairing(false);
    }
  };
  return (
    <NodeDialog
      wide
      title={t("Source nodes")}
      description={t("Connect your machines. Keep your sessions together.")}
      onClose={onClose}
      busy={pairing}
      headerAction={
        <button
          className={nodePrimary}
          disabled={pairing || query.isError}
          onClick={() => {
            void pair();
          }}
        >
          <Plug aria-hidden="true" className="size-4" />
          {pairing ? t("Working…") : t("Pair a Worker")}
        </button>
      }
    >
      {(error || query.isError) && (
        <p role="alert" className="mt-4 text-sm text-[var(--console-error)]">
          {error ?? t("Unable to load nodes. Check the Hub connection.")}
          <button
            className={`${nodeButton} ml-2`}
            onClick={() => {
              void query.refetch();
            }}
          >
            {t("Retry")}
          </button>
        </p>
      )}
      {query.isPending && (
        <p role="status" className="py-8 text-center text-sm text-[var(--console-muted)]">
          {t("Loading...")}
        </p>
      )}
      {query.isSuccess && nodes.length === 0 && (
        <p className="py-8 text-center text-sm text-[var(--console-muted)]">
          {t("No Workers paired. Create a token to connect your first machine.")}
        </p>
      )}
      {selected && (
        <div
          className={
            nodes.length > 1 ? "mt-4 grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]" : "mt-4"
          }
        >
          {nodes.length > 1 && (
            <ul aria-label={t("Source nodes")} className="space-y-1">
              {nodes.map((node) => {
                const online = isNodeOnline(node, now) && !query.isError;
                const attention = nodeNeedsAttention(node);
                return (
                  <li key={node.id}>
                    <button
                      aria-pressed={selected.id === node.id}
                      onClick={() => {
                        setSelectedId(node.id);
                        setNotice(null);
                      }}
                      className={`motion-hover w-full rounded-md border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${selected.id === node.id ? "border-[var(--brand)] bg-[var(--brand-soft)]" : "border-transparent hover:bg-[var(--console-surface-muted)]"}`}
                    >
                      <span className="console-mono block truncate text-sm font-medium">
                        {node.name}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-[var(--console-muted)]">
                        <span
                          aria-hidden="true"
                          className={`size-1.5 shrink-0 rounded-full ${attention ? "bg-[var(--console-warning)]" : online ? "bg-[var(--console-success)]" : "bg-[var(--console-muted)]"}`}
                        />
                        {query.isError
                          ? t("Node status unavailable")
                          : node.revoked
                            ? t("Access revoked")
                            : node.error
                              ? t("Needs attention")
                              : online
                                ? node.queue?.batches
                                  ? t("Uploading · {0} batches", [node.queue.batches])
                                  : t("Synced {0}", [
                                      formatRelativeTime(node.lastConfirmedAt ?? node.lastSeen),
                                    ])
                                : t("Offline · last seen {0}", [formatRelativeTime(node.lastSeen)])}
                      </span>
                      {!node.error && attention && (
                        <span className="mt-1 block text-xs text-[var(--console-warning)]">
                          {t("{0} sources need attention", [missingSources(node).length])}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <section
            key={selected.id}
            className="min-w-0 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4 sm:p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="console-mono break-words text-lg font-semibold">{selected.name}</h3>
                <p className="console-mono mt-1 break-all text-xs text-[var(--console-muted)]">
                  {[
                    selected.health?.host && hostSummary(selected.health.host, selected.name),
                    selected.id === "local" && t("Local source"),
                    `Worker v${selected.version}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className={nodeButton}
                  onClick={() => setAction({ kind: "rename", node: selected })}
                >
                  <Pencil aria-hidden="true" className="size-3.5" />
                  {t("Rename")}
                </button>
                <button
                  className={nodeButton}
                  disabled={query.isError}
                  onClick={() => setAction({ kind: "replace", node: selected })}
                >
                  {t("Replace Worker")}
                </button>
              </div>
            </div>
            <dl className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">{t("Collection status")}</dt>
                <dd className="mt-1 text-sm">
                  {query.isError ? t("Node status unavailable") : collectionStatus(selected, now)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("Last confirmed sync")}</dt>
                <dd
                  className="mt-1 text-sm"
                  title={
                    selected.lastConfirmedAt
                      ? new Date(selected.lastConfirmedAt).toLocaleString()
                      : undefined
                  }
                >
                  {selected.lastConfirmedAt
                    ? formatRelativeTime(selected.lastConfirmedAt)
                    : t("Not reported yet")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("Pending uploads")}</dt>
                <dd className="mt-1 text-sm">
                  {selected.queue
                    ? t("{0} pending batches · {1} MB", [
                        selected.queue.batches,
                        (selected.queue.bytes / 1048576).toFixed(1),
                      ])
                    : t("Queue status unavailable")}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {query.isError ? t("Node status unavailable") : nodeStatus(selected, now)}
            </p>
            {!query.isError &&
              missingSources(selected).map((agent) => (
                <div
                  key={agent}
                  role="status"
                  className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--console-warning)] bg-[var(--console-warning-bg)] px-3 py-2.5"
                >
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {t("{0} source no longer found", [agentDisplayName(agent)])}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--console-text-secondary)]">
                      {t("{0} collected sessions remain. Ignore it if the Agent was removed.", [
                        selected.agents[agent]?.sessions ?? 0,
                      ])}
                    </p>
                  </div>
                  <button
                    className={nodeButton}
                    disabled={ignoring}
                    onClick={() => {
                      void toggleIgnored(selected.id, agent, true);
                    }}
                  >
                    {t("Ignore source")}
                  </button>
                </div>
              ))}
            <section className="mt-5 border-t border-border pt-4" aria-label={t("Agent sources")}>
              <h4 className="mb-1 text-sm font-semibold">{t("Agent sources")}</h4>
              <CollectionSources
                sources={selected.health?.collection.sources}
                stale={
                  query.isError ||
                  !isNodeOnline(selected, now) ||
                  selected.health == null ||
                  now - selected.health.reportedAt > 60000 ||
                  Boolean(selected.error)
                }
                uploading={Boolean(selected.queue?.batches)}
                activity={selected.agents}
                ignored={selected.ignoredSources}
                onStopIgnoring={
                  query.isError || ignoring
                    ? undefined
                    : (agent) => {
                        void toggleIgnored(selected.id, agent, false);
                      }
                }
              />
            </section>
            {recoveryHint && recoveryHint !== nodeStatus(selected, now) && (
              <p role="status" className="mt-3 text-sm text-[var(--console-warning)]">
                {recoveryHint}
              </p>
            )}
            {!selected.health?.collection.sources &&
              selected.health &&
              Object.entries(selected.health.collection.errors).map(([agent, error]) => (
                <details key={agent} className="mt-3 text-xs text-[var(--console-error)]">
                  <summary>{t("Collection failed: {0}", [agent])}</summary>
                  <p className="mt-2 break-words">{error}</p>
                </details>
              ))}
            {selected.queue?.oldestAt && (
              <p className="mt-2 text-xs text-[var(--console-muted)]">
                {t("Oldest pending: {0}", [new Date(selected.queue.oldestAt).toLocaleString()])}
              </p>
            )}
            {selected.error && (
              <details className="mt-3 text-xs text-[var(--console-error)]">
                <summary>{t("Error details")}</summary>
                <p className="mt-2 break-words">{selected.error}</p>
              </details>
            )}
            {selected.incompleteSessions > 0 && (
              <p className="mt-3 text-sm text-[var(--console-error)]">
                {t("{0} sessions need source content or a backup.", [selected.incompleteSessions])}
              </p>
            )}
            <details className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
              <summary className="cursor-pointer">{t("Diagnostics")}</summary>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt>{t("Node ID")}</dt>
                  <dd className="console-mono mt-1 break-all">{selected.id}</dd>
                </div>
                <div>
                  <dt>{t("Last heartbeat")}</dt>
                  <dd className="mt-1">
                    {selected.lastSeen
                      ? new Date(selected.lastSeen).toLocaleString()
                      : t("Not connected yet")}
                  </dd>
                </div>
                <div>
                  <dt>{t("Last successful scan")}</dt>
                  <dd className="mt-1">
                    {selected.health?.collection.lastSuccessAt
                      ? new Date(selected.health.collection.lastSuccessAt).toLocaleString()
                      : t("Not reported yet")}
                  </dd>
                </div>
              </dl>
              {selected.health && (
                <p className="mt-3">
                  {t("Status reported: {0}", [
                    new Date(selected.health.reportedAt).toLocaleString(),
                  ])}
                </p>
              )}
            </details>
            <NodeTasks
              key={selected.id}
              node={selected}
              now={now}
              tasks={query.data?.tasks ?? []}
              unavailable={query.isError}
            />
            {!selected.revoked && (
              <div className="mt-5 flex flex-wrap justify-between gap-3 border-t border-[var(--console-border)] pt-4">
                <button
                  className={nodeButton}
                  disabled={query.isError}
                  onClick={() => setAction({ kind: "rescan", nodes: [selected], all: false })}
                >
                  {t("Rescan")}
                </button>
                <button
                  className={`${nodeButton} text-[var(--console-muted)]`}
                  disabled={query.isError}
                  onClick={() => setAction({ kind: "revoke", node: selected })}
                >
                  {t("Revoke access")}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {query.data?.local && (
        <p className="mt-4 text-xs text-[var(--console-muted)]">
          {t("Local collection is disabled. Saved history remains available.")}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-[var(--console-success)]">
          {notice}
        </p>
      )}
      <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--console-border)] pt-4 text-xs text-[var(--console-muted)]">
        <div className="space-y-1">
          <p>
            {query.isError
              ? t("Node status unavailable")
              : t("{0}/{1} online", [
                  active.filter((node) => isNodeOnline(node, now)).length,
                  active.length,
                ])}
          </p>
          <p>
            {t("Hub v{0} · minimum Worker version: {1}", [
              query.data?.version ?? "…",
              query.data?.minimumWorkerVersion ?? "…",
            ])}
          </p>
        </div>
        <button
          className={nodeButton}
          disabled={!active.length || query.isError}
          onClick={() => setAction({ kind: "rescan", nodes: active, all: true })}
        >
          {t("Rescan all Workers")}
        </button>
      </footer>
      {action && (
        <NodeActions
          action={action}
          onClose={() => setAction(null)}
          onUpdated={() => {
            setNotice(action.kind === "rescan" ? t("Rescan requested.") : t("Node updated."));
            void query.refetch();
          }}
        />
      )}
    </NodeDialog>
  );
}
