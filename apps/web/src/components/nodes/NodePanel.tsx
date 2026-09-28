import { Dialog } from "@base-ui/react/dialog";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { AGENT_CATALOG, sessionRoutePath } from "@codesesh/contract";
import { useLocale } from "../../hooks/useLocale";
import { useNodes } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import {
  createPairingToken,
  fetchSourceSessions,
  requestRescan,
  updateNode,
  type SourceNode,
  type NodeTask,
} from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { writeToClipboard } from "../../lib/clipboard";
import { X } from "../ui/icons";

const button =
  "rounded-sm border border-[var(--console-border)] px-3 py-1.5 text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50";
const input =
  "rounded-sm border border-[var(--console-border)] bg-[var(--console-bg)] px-2 py-1.5 text-sm text-[var(--console-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";

function nodeStatus(node: SourceNode) {
  if (node.revoked) return t("Access revoked");
  if (node.error?.includes("WORKER_TOO_NEW"))
    return t("Upgrade Hub first. Collection and uploads are paused.");
  if (node.error?.includes("WORKER_TOO_OLD"))
    return t("Upgrade this Worker. Collection and uploads are paused.");
  if (node.error) return t("Worker reported an error. Check its logs.");
  if (!node.lastSeen) return t("Waiting for first connection");
  if (Date.now() - node.lastSeen > 60000) return t("Offline. Saved history remains available.");
  if (!node.collectionComplete) return t("Collecting history");
  return node.queue?.batches ? t("Connected, uploading") : t("Connected, up to date");
}

function taskLabel(status: string) {
  const labels: Record<string, string> = {
    waiting: t("Waiting for node"),
    running: t("Scanning"),
    uploading: t("Waiting for upload confirmation"),
    paused: t("Paused"),
    failed: t("Failed"),
    completed: t("Completed"),
    partial: t("Source content is missing"),
    superseded: t("Replaced by recovery"),
  };
  return labels[status] ?? status;
}

function NodeRow({
  node,
  task,
  busy,
  run,
  onBrowse,
  rescanAgents,
}: {
  node: SourceNode;
  task?: NodeTask;
  busy: boolean;
  run: (operation: () => Promise<unknown>) => void;
  onBrowse: () => void;
  rescanAgents: string[];
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(node.name);
  const [revoking, setRevoking] = useState(false);
  return (
    <li className="grid gap-3 border-b border-[var(--console-border)] py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        {renaming ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await updateNode(node.id, "name", name);
                setRenaming(false);
              });
            }}
          >
            <input
              aria-label={t("Node name")}
              className={input}
              value={name}
              maxLength={128}
              onChange={(event) => setName(event.target.value)}
            />
            <button className={button} disabled={busy || !name.trim()}>
              {t("Save")}
            </button>
            <button type="button" className={button} onClick={() => setRenaming(false)}>
              {t("Cancel")}
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-[var(--console-text)]">{node.name}</h3>
            <span className="text-xs text-[var(--console-muted)]">v{node.version}</span>
          </div>
        )}
        <p className="mt-1 text-sm text-[var(--console-muted)]">{nodeStatus(node)}</p>
        <p className="mt-1 break-all text-xs text-[var(--console-muted)]">{node.id}</p>
        {node.error && (
          <details className="mt-2 text-xs text-[var(--console-error)]">
            <summary>{t("Error details")}</summary>
            <p className="mt-1 break-words">{node.error}</p>
          </details>
        )}
        {task && (
          <p className="mt-2 text-xs text-[var(--console-text)]">
            {t("Rescan")}: {taskLabel(task.status)}
            {task.progress?.error ? ` — ${task.progress.error}` : ""}
          </p>
        )}
        {node.incompleteSessions > 0 && (
          <p role="status" className="mt-2 text-sm text-[var(--console-error)]">
            {t("{0} sessions need source content or a backup.", [node.incompleteSessions])}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <p className="text-sm text-[var(--console-text)]">
          {node.queue
            ? t("{0} pending batches · {1} MB", [
                node.queue.batches,
                (node.queue.bytes / 1048576).toFixed(1),
              ])
            : t("Queue status unavailable")}
        </p>
        <p className="text-xs text-[var(--console-muted)]">
          {node.lastSeen
            ? t("Last seen: {0}", [new Date(node.lastSeen).toLocaleString()])
            : t("Not connected yet")}
        </p>
        {node.queue?.oldestAt && (
          <p className="text-xs text-[var(--console-muted)]">
            {t("Oldest pending: {0}", [new Date(node.queue.oldestAt).toLocaleString()])}
          </p>
        )}
        {node.lastConfirmedAt && (
          <p className="text-xs text-[var(--console-muted)]">
            {t("Last confirmed: {0}", [new Date(node.lastConfirmedAt).toLocaleString()])}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={onBrowse}>
            {t("Browse sessions")}
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setRenaming(true)}
            disabled={busy}
          >
            {t("Rename")}
          </button>
          {!node.revoked && (
            <>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => run(() => requestRescan([node.id], rescanAgents))}
              >
                {t("Rescan")}
              </button>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => setRevoking(!revoking)}
              >
                {t("Revoke access")}
              </button>
            </>
          )}
        </div>
        {revoking && (
          <div className="text-sm text-[var(--console-text)]">
            <p>{t("Stop this node from uploading? Saved history will remain.")}</p>
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await updateNode(node.id, "revoke");
                  setRevoking(false);
                })
              }
            >
              {t("Confirm revoke")}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function NodePanel({ onClose }: { onClose: () => void }) {
  useLocale();
  const nodes = useNodes();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ token: string; expires: number } | null>(null);
  const [source, setSource] = useState("");
  const [rescanAgent, setRescanAgent] = useState("");
  const rescanAgents = rescanAgent ? [rescanAgent] : [];
  const sessions = useInfiniteQuery({
    queryKey: [...queryKeys.nodeSessions, source],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchSourceSessions(source || undefined, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
  const run = (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void operation()
      .then(() => nodes.refetch())
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : t("Unable to update node.")),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-[var(--scrim)]" />
        <Dialog.Popup className="console-scrollbar fixed left-1/2 top-1/2 z-[71] max-h-[90vh] w-[min(96vw,1000px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-[var(--console-border)] bg-[var(--console-bg)] p-5 shadow-[var(--shadow-drawer)] focus:outline-none sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-xl font-semibold text-[var(--console-text)]">
                {t("Source nodes")}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-[var(--console-muted)]">
                {t("Workers collect sessions. This Hub keeps your history.")}
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label={t("Close")} className={button}>
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--console-border)] pb-4">
            <p className="text-sm text-[var(--console-text)]">
              Hub v{nodes.data?.version ?? "…"} ·{" "}
              {t("Minimum Worker version: {0}", [nodes.data?.minimumWorkerVersion ?? "…"])}
            </p>
            <div className="flex gap-2">
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const value = await createPairingToken();
                    setPairing({
                      token: value.token,
                      expires: Date.now() + value.expiresInSeconds * 1000,
                    });
                  })
                }
              >
                {t("Pair a Worker")}
              </button>
              <button
                className={button}
                disabled={busy || !nodes.data?.nodes.some((node) => !node.revoked)}
                onClick={() => run(() => requestRescan([], rescanAgents))}
              >
                {t("Rescan all Workers")}
              </button>
            </div>
          </div>
          <label className="mt-4 flex flex-wrap items-center gap-3 text-sm text-[var(--console-muted)]">
            {t("Rescan Agent")}
            <select
              className={input}
              value={rescanAgent}
              onChange={(event) => setRescanAgent(event.target.value)}
            >
              <option value="">{t("All agents")}</option>
              {AGENT_CATALOG.map((agent) => (
                <option key={agent.name} value={agent.name}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
          {pairing && (
            <section className="mt-4 rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] p-4">
              <h3 className="font-semibold text-[var(--console-text)]">
                {t("One-time pairing token")}
              </h3>
              <p className="mt-1 text-sm text-[var(--console-muted)]">
                {t("Expires at {0}. Paste it into the Worker prompt.", [
                  new Date(pairing.expires).toLocaleTimeString(),
                ])}
              </p>
              <textarea
                readOnly
                aria-label={t("One-time pairing token")}
                className={`${input} mt-2 w-full break-all`}
                value={pairing.token}
              />
              <button
                className={`${button} mt-2`}
                onClick={() => {
                  void writeToClipboard(pairing.token);
                }}
              >
                {t("Copy token")}
              </button>
              <pre className="mt-3 overflow-x-auto text-xs text-[var(--console-text)]">
                codesesh worker --hub {window.location.origin} --pair-token-stdin
              </pre>
            </section>
          )}
          {(error || nodes.isError) && (
            <p role="alert" className="mt-4 text-sm text-[var(--console-error)]">
              {error ?? t("Unable to load nodes. Check the Hub connection.")}
            </p>
          )}
          {nodes.isPending && (
            <p role="status" className="mt-4 text-[var(--console-muted)]">
              {t("Loading...")}
            </p>
          )}
          {nodes.data?.local && (
            <div className="border-b border-[var(--console-border)] py-4">
              <h3 className="font-semibold text-[var(--console-text)]">{t("Local source")}</h3>
              <p className="mt-1 text-sm text-[var(--console-muted)]">
                {nodes.data.local.enabled
                  ? t("Local collection is enabled.")
                  : t("Local collection is disabled. Saved history remains available.")}
              </p>
            </div>
          )}
          <ul className="pl-3 sm:pl-5">
            {nodes.data?.nodes.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                task={nodes.data?.tasks.find((task) => task.nodeId === node.id)}
                busy={busy}
                run={run}
                onBrowse={() => setSource(node.id)}
                rescanAgents={rescanAgents}
              />
            ))}
          </ul>
          {nodes.data?.nodes.length === 0 && (
            <p className="py-6 text-sm text-[var(--console-muted)]">
              {t("No Workers paired. Create a token to connect your first machine.")}
            </p>
          )}
          <section className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-[var(--console-text)]">
                {t("Sessions by source")}
              </h2>
              <select
                className={input}
                aria-label={t("Source node")}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">{t("All sources")}</option>
                {nodes.data?.local && <option value="local">{t("Local source")}</option>}
                {nodes.data?.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </div>
            {sessions.isError && (
              <p role="alert" className="mt-3 text-sm text-[var(--console-error)]">
                {t("Unable to load sessions.")}{" "}
                <button
                  className={button}
                  onClick={() => {
                    void sessions.refetch();
                  }}
                >
                  {t("Retry")}
                </button>
              </p>
            )}
            {sessions.isPending && (
              <p role="status" className="mt-3 text-sm text-[var(--console-muted)]">
                {t("Loading recent sessions")}
              </p>
            )}
            {sessions.isSuccess &&
              sessions.data.pages.every((page) => page.sessions.length === 0) && (
                <p className="mt-3 text-sm text-[var(--console-muted)]">{t("No sessions yet")}</p>
              )}
            <ul className="mt-3 divide-y divide-[var(--console-border)]">
              {sessions.data?.pages
                .flatMap((page) => page.sessions)
                .map((session) => (
                  <li key={sessionRoutePath(session.reference)}>
                    <Link
                      to={sessionRoutePath(session.reference)}
                      onClick={onClose}
                      className="block rounded-sm py-3 text-sm text-[var(--console-text)] hover:text-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                    >
                      <span>{session.display_title ?? session.title}</span>
                      <span className="ml-2 text-xs text-[var(--console-muted)]">
                        {session.reference.agentName} ·{" "}
                        {nodes.data?.nodes.find(
                          (node) => node.id === session.reference.sourceNodeId,
                        )?.name ?? t("Local source")}
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
            {sessions.hasNextPage && (
              <button
                className={`${button} mt-3`}
                disabled={sessions.isFetchingNextPage}
                onClick={() => {
                  void sessions.fetchNextPage();
                }}
              >
                {t("Load more")}
              </button>
            )}
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
