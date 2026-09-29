import { useState } from "react";
import { AGENT_CATALOG } from "@codesesh/contract";
import { t } from "./pairing-messages";
import { createPairingToken, requestRescan, updateNode, type SourceNode } from "../../lib/api";
import { NodePairing } from "./NodePairing";
import { NativeSelect } from "../ui/native-select";
import { NodeDialog, nodeButton, nodePrimary } from "./NodeDialog";

export type NodeAction =
  | { kind: "pair"; token: string; expires: number }
  | { kind: "rescan"; nodes: SourceNode[]; all: boolean }
  | { kind: "revoke"; node: SourceNode }
  | { kind: "replace"; node: SourceNode }
  | { kind: "rename"; node: SourceNode };

export function NodeActions({
  action,
  onClose,
  onUpdated,
}: {
  action: NodeAction;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [replacement, setReplacement] = useState<{ token: string; expires: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const [agent, setAgent] = useState("");
  const [name, setName] = useState(action.kind === "rename" ? action.node.name : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title =
    action.kind === "pair"
      ? t("Pair a Worker")
      : action.kind === "replace"
        ? t("Replace Worker for {0}?", [action.node.name])
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
      : action.kind === "replace"
        ? t(
            "Keep this source identity, history, bookmarks, and titles. The old Worker's credentials stop working when the replacement pairs successfully.",
          )
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
      if (action.kind === "replace") {
        const value = await createPairingToken(action.node.id);
        setReplacement({ token: value.token, expires: Date.now() + value.expiresInSeconds * 1000 });
        return;
      }
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
        <NodePairing token={action.token} expires={action.expires} />
      ) : action.kind === "replace" && replacement ? (
        <NodePairing
          token={replacement.token}
          expires={replacement.expires}
          replacementNodeId={action.node.id}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="mt-6 space-y-5"
        >
          {action.kind === "replace" && (
            <p className="break-words text-sm">
              {action.node.id === "local"
                ? t(
                    "The local source can only be replaced from this Hub's data directory. Other machines must be added as new Workers.",
                  )
                : t(
                    "Run the pairing command only on the machine that should continue this source. A new token replaces any earlier replacement token for this node.",
                  )}
            </p>
          )}
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
                  : action.kind === "replace"
                    ? t("Create replacement token")
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
