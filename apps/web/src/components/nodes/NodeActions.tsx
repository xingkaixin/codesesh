import { useEffect, useState } from "react";
import { AGENT_CATALOG } from "@codesesh/contract";
import { useNodeClock } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import { requestRescan, updateNode, type SourceNode } from "../../lib/api";
import { writeToClipboard } from "../../lib/clipboard";
import { Check, Copy } from "../ui/icons";
import { NativeSelect } from "../ui/native-select";
import { NodeDialog, nodeButton, nodePrimary } from "./NodeDialog";

export type NodeAction =
  | { kind: "pair"; token: string; expires: number }
  | { kind: "rescan"; nodes: SourceNode[]; all: boolean }
  | { kind: "revoke"; node: SourceNode }
  | { kind: "rename"; node: SourceNode };

function CopyButton({
  value,
  label,
  disabled = false,
}: {
  value: string;
  label: string;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status !== "copied") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (
    <div>
      <button
        className={nodeButton}
        disabled={disabled || status === "copying"}
        onClick={async () => {
          setStatus("copying");
          setStatus((await writeToClipboard(value)) ? "copied" : "failed");
        }}
      >
        <span className="relative size-4" aria-hidden="true">
          <Copy
            className={`absolute inset-0 size-4 transition-[opacity,transform] duration-150 motion-reduce:transition-none ${status === "copied" ? "scale-75 opacity-0" : "scale-100 opacity-100"}`}
          />
          <Check
            className={`absolute inset-0 size-4 text-[var(--console-success)] transition-[opacity,transform] duration-150 motion-reduce:transition-none ${status === "copied" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
          />
        </span>
        <span aria-live="polite">
          {status === "copied" ? t("Copied") : status === "copying" ? t("Copying…") : label}
        </span>
      </button>
      {status === "failed" && (
        <p role="alert" className="mt-2 text-xs text-[var(--console-error)]">
          {t("Copy failed. Select and copy the text manually.")}
        </p>
      )}
    </div>
  );
}

export function NodeActions({
  action,
  onClose,
  onUpdated,
}: {
  action: NodeAction;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [finished, setFinished] = useState(false);
  const [agent, setAgent] = useState("");
  const [name, setName] = useState(action.kind === "rename" ? action.node.name : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNodeClock();
  const command = `codesesh worker --hub ${window.location.origin} --pair-token-stdin`;
  const title =
    action.kind === "pair"
      ? t("Pair a Worker")
      : action.kind === "rename"
        ? t("Rename")
        : action.kind === "revoke"
          ? t("Revoke access to {0}?", [action.node.name])
          : action.all
            ? t("Rescan all Workers")
            : t("Rescan {0}", [action.nodes[0]?.name ?? "Worker"]);
  const description =
    action.kind === "pair"
      ? t("Run this command on the Worker machine, then paste the one-time token.")
      : action.kind === "rename"
        ? t("Choose a name to identify this machine.")
        : action.kind === "revoke"
          ? t(
              "This Worker will stop uploading. Saved history remains. Reconnecting requires pairing again.",
            )
          : t(
              "Re-read source files and update existing sessions. Offline Workers will run this task when they reconnect.",
            );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "rescan")
        await requestRescan(
          action.nodes.map((node) => node.id),
          agent ? [agent] : [],
        );
      if (action.kind === "revoke") await updateNode(action.node.id, "revoke");
      if (action.kind === "rename") await updateNode(action.node.id, "name", name.trim());
      onUpdated();
      setFinished(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Unable to update node."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <NodeDialog
      title={title}
      description={description}
      onClose={onClose}
      busy={busy}
      closeRequested={finished}
    >
      {action.kind === "pair" ? (
        <div className="mt-6 space-y-5">
          <div className="space-y-3 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4">
            <code className="block break-all text-xs">{command}</code>
            <p className="text-xs text-[var(--console-muted)]">
              {t(
                "For another machine, replace the Hub URL with an address reachable from that Worker.",
              )}
            </p>
            <CopyButton value={command} label={t("Copy command")} />
          </div>
          <label className="block space-y-2 text-sm">
            <span>{t("One-time pairing token")}</span>
            <textarea
              readOnly
              value={action.token}
              className="console-mono w-full resize-none rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-3 text-xs"
            />
          </label>
          <CopyButton
            value={action.token}
            label={t("Copy token")}
            disabled={now >= action.expires}
          />
          <p role="status" className="text-xs text-[var(--console-muted)]">
            {now >= action.expires
              ? t("Token expired. Close this dialog and create a new token.")
              : t("Expires at {0}. Paste it into the Worker prompt.", [
                  new Date(action.expires).toLocaleTimeString(),
                ])}
          </p>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="mt-6 space-y-5"
        >
          {action.kind === "rescan" && (
            <>
              <p className="text-sm">
                {t("Target Workers: {0}", [action.nodes.map((node) => node.name).join(", ")])}
              </p>
              <label className="flex flex-wrap items-center gap-3 text-sm">
                {t("Rescan Agent")}
                <NativeSelect
                  value={agent}
                  onChange={(event) => setAgent(event.target.value)}
                  disabled={busy}
                >
                  <option value="">{t("All agents")}</option>
                  {AGENT_CATALOG.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.displayName}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </>
          )}
          {action.kind === "rename" && (
            <input
              aria-label={t("Node name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={128}
              disabled={busy}
              className="w-full rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-2 text-sm"
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-[var(--console-error)]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              className={nodeButton}
              onClick={() => setFinished(true)}
            >
              {t("Cancel")}
            </button>
            <button
              disabled={busy || (action.kind === "rename" && !name.trim())}
              className={
                action.kind === "revoke"
                  ? `${nodeButton} text-[var(--console-error)] border-[var(--console-error)]`
                  : nodePrimary
              }
            >
              {busy
                ? t("Working…")
                : action.kind === "revoke"
                  ? t("Confirm revoke")
                  : action.kind === "rename"
                    ? t("Save")
                    : t("Confirm rescan")}
            </button>
          </div>
        </form>
      )}
    </NodeDialog>
  );
}
