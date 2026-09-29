import { useState } from "react";
import { useLocale } from "../../hooks/useLocale";
import { isNodeOnline, useNodeClock, useNodes } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import { createPairingToken } from "../../lib/api";
import { Monitor, Plug, Pencil, ChevronUp } from "../ui/icons";
import { NodeDialog, nodeButton, nodePrimary } from "./NodeDialog";
import { NodeActions, type NodeAction } from "./NodeActions";
import { collectionStatus, nodeRecoveryHint, nodeStatus, taskLabel } from "./node-status";

export function NodePanel({ onClose }: { onClose: () => void }) {
  useLocale();
  const query = useNodes();
  const now = useNodeClock();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<NodeAction | null>(null);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nodes = query.data?.nodes ?? [];
  const active = nodes.filter((node) => !node.revoked);
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0];
  const recoveryHint = selected ? nodeRecoveryHint(selected) : null;
  const task = query.data?.tasks.find((task) => task.nodeId === selected?.id);
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
      <div className="mx-auto mt-3 flex w-fit items-center gap-3 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] px-6 py-4">
        <Plug aria-hidden="true" className="size-6 text-[var(--console-muted)]" />
        <div>
          <p className="font-semibold">Hub</p>
          <p className="console-mono text-xs text-[var(--console-muted)]">
            v{query.data?.version ?? "…"}
          </p>
        </div>
      </div>
      {nodes.length > 0 && (
        <div className="relative pt-9">
          <div
            aria-hidden="true"
            className="absolute left-1/2 top-0 h-9 border-l border-[var(--console-border-strong)]"
          >
            <ChevronUp className="absolute -left-1.5 top-0 size-3 text-[var(--console-muted)]" />
          </div>
          <ul
            aria-label={t("Source nodes")}
            className={`mx-auto grid grid-cols-1 gap-x-3 gap-y-4 ${nodes.length === 1 ? "max-w-sm" : nodes.length === 2 ? "max-w-2xl border-t border-[var(--console-border-strong)] sm:grid-cols-2" : "border-t border-[var(--console-border-strong)] sm:grid-cols-2 lg:grid-cols-3"}`}
          >
            {nodes.map((node) => (
              <li key={node.id} className="relative pt-5">
                <span
                  aria-hidden="true"
                  className="absolute left-1/2 top-0 h-5 border-l border-[var(--console-border-strong)]"
                />
                <button
                  aria-pressed={selected?.id === node.id}
                  onClick={() => {
                    setSelectedId(node.id);
                    setNotice(null);
                  }}
                  className={`motion-hover motion-press flex h-full w-full items-center gap-3 rounded-lg border p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${selected?.id === node.id ? "border-[var(--brand)] bg-[var(--brand-soft)]" : "border-[var(--console-border)] bg-[var(--console-surface)] hover:border-[var(--console-border-strong)]"}`}
                >
                  <Monitor
                    aria-hidden="true"
                    className="size-6 shrink-0 text-[var(--console-muted)]"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{node.name}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-[var(--console-muted)]">
                      <span
                        aria-hidden="true"
                        className={`size-1.5 shrink-0 rounded-full ${node.error ? "bg-[var(--console-warning)]" : isNodeOnline(node, now) && !query.isError ? "bg-[var(--console-success)]" : "bg-[var(--console-muted)]"}`}
                      />
                      {query.isError
                        ? t("Node status unavailable")
                        : node.revoked
                          ? t("Access revoked")
                          : node.error
                            ? t("Needs attention")
                            : isNodeOnline(node, now)
                              ? t("Online")
                              : t("Offline")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {query.isSuccess && nodes.length === 0 && (
        <p className="py-8 text-center text-sm text-[var(--console-muted)]">
          {t("No Workers paired. Create a token to connect your first machine.")}
        </p>
      )}
      {selected && (
        <section
          key={selected.id}
          className="mt-6 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="break-words text-lg font-semibold">{selected.name}</h3>
              <p className="console-mono mt-1 break-all text-xs text-[var(--console-muted)]">
                {selected.id === "local" ? t("Local source") : selected.id}
              </p>
            </div>
            <button
              className={nodeButton}
              onClick={() => setAction({ kind: "rename", node: selected })}
            >
              <Pencil aria-hidden="true" className="size-3.5" />
              {t("Rename")}
            </button>
          </div>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--console-muted)]">{t("Worker version")}</dt>
              <dd className="mt-1 text-sm">v{selected.version}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--console-muted)]">{t("Last heartbeat")}</dt>
              <dd className="mt-1 text-sm">
                {selected.lastSeen
                  ? new Date(selected.lastSeen).toLocaleString()
                  : t("Not connected yet")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--console-muted)]">{t("Pending uploads")}</dt>
              <dd className="mt-1 text-sm">
                {selected.queue
                  ? t("{0} pending batches · {1} MB", [
                      selected.queue.batches,
                      (selected.queue.bytes / 1048576).toFixed(1),
                    ])
                  : t("Queue status unavailable")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--console-muted)]">{t("Sync status")}</dt>
              <dd className="mt-1 text-sm">
                {query.isError ? t("Node status unavailable") : nodeStatus(selected, now)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--console-muted)]">{t("Collection status")}</dt>
              <dd className="mt-1 text-sm">
                {query.isError ? t("Node status unavailable") : collectionStatus(selected, now)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--console-muted)]">{t("Last successful scan")}</dt>
              <dd className="mt-1 text-sm">
                {selected.health?.collection.lastSuccessAt
                  ? new Date(selected.health.collection.lastSuccessAt).toLocaleString()
                  : t("Not reported yet")}
              </dd>
            </div>
          </dl>
          {selected.health && (
            <p className="mt-4 text-xs text-[var(--console-muted)]">
              {t("Status reported: {0}", [new Date(selected.health.reportedAt).toLocaleString()])}
            </p>
          )}
          {recoveryHint && recoveryHint !== nodeStatus(selected, now) && (
            <p role="status" className="mt-3 text-sm text-[var(--console-warning)]">
              {recoveryHint}
            </p>
          )}
          {selected.health &&
            Object.entries(selected.health.collection.errors).map(([agent, error]) => (
              <details key={agent} className="mt-3 text-xs text-[var(--console-error)]">
                <summary>{t("Collection failed: {0}", [agent])}</summary>
                <p className="mt-2 break-words">{error}</p>
              </details>
            ))}
          {selected.lastConfirmedAt && (
            <p className="mt-4 text-xs text-[var(--console-muted)]">
              {t("Last confirmed: {0}", [new Date(selected.lastConfirmedAt).toLocaleString()])}
            </p>
          )}
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
          {task && (
            <p className="mt-3 text-sm">
              {t("Rescan")}: {taskLabel(task.status)}
              {task.progress?.error ? ` — ${task.progress.error}` : ""}
            </p>
          )}
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
          <p>{t("Minimum Worker version: {0}", [query.data?.minimumWorkerVersion ?? "…"])}</p>
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
