import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";

export interface SessionAliasTarget {
  agentKey: string;
  sessionId: string;
  title: string;
  displayTitle?: string;
}

interface SessionAliasDialogProps {
  target: SessionAliasTarget | null;
  onClose: () => void;
  onSave: (alias: string) => Promise<void>;
  onRemove: () => Promise<void>;
}

export function SessionAliasDialog(props: SessionAliasDialogProps) {
  useLocale();

  const { target } = props;
  const stateKey = target ? `${target.agentKey}/${target.sessionId}` : "closed";
  return <SessionAliasDialogState key={stateKey} {...props} />;
}

function SessionAliasDialogState({ target, onClose, onSave, onRemove }: SessionAliasDialogProps) {
  useLocale();

  const [alias, setAlias] = useState(() => target?.displayTitle ?? target?.title ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const activeRequest = useRef<symbol | null>(null);

  useEffect(
    () => () => {
      activeRequest.current = null;
    },
    [],
  );

  const runOperation = async (operation: () => Promise<void>, fallbackError: string) => {
    if (activeRequest.current) return;
    const request = Symbol();
    activeRequest.current = request;
    setSaving(true);
    setError(null);
    try {
      await operation();
      if (activeRequest.current === request) onClose();
    } catch (operationError) {
      if (activeRequest.current !== request) return;
      setError(operationError instanceof Error ? operationError.message : fallbackError);
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setSaving(false);
      }
    }
  };

  const saveAlias = async () => {
    if (!target) return;
    const nextAlias = alias.trim();
    if (!nextAlias || nextAlias === target.title.trim()) {
      await removeAlias();
      return;
    }

    await runOperation(() => onSave(nextAlias), "Could not rename this session.");
  };

  const removeAlias = async () => {
    if (!target) return;
    await runOperation(onRemove, "Could not restore the title.");
  };

  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="motion-backdrop fixed inset-0 z-50 bg-[var(--scrim)]" />
        <Dialog.Popup className="motion-modal fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-5 shadow-[var(--shadow-overlay)] outline-none">
          <Dialog.Title className="console-mono text-sm font-semibold text-[var(--console-text)]">
            {t("Rename session")}
          </Dialog.Title>
          <label className="console-mono mt-4 block text-[11px] uppercase tracking-wide text-[var(--console-muted)]">
            {t("Session title")}{" "}
            <input
              autoFocus
              autoComplete="off"
              name="session-title"
              maxLength={160}
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveAlias();
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "session-alias-error" : undefined}
              className="mt-1.5 w-full rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--console-text)] outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand)]/25"
            />
          </label>
          {error ? (
            <p
              id="session-alias-error"
              aria-live="polite"
              className="mt-2 text-xs text-[var(--console-error)]"
            >
              {t(error)}
            </p>
          ) : null}
          <div className="mt-5 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => void removeAlias()}
              disabled={saving || !target?.displayTitle}
              className="text-xs text-[var(--console-muted)] underline decoration-[var(--console-border-strong)] underline-offset-4 hover:text-[var(--console-text)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("Remove custom title")}
            </button>
            <div className="flex items-center gap-2">
              <Dialog.Close className="rounded-sm border border-[var(--console-border)] px-3 py-1.5 text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)]">
                {t("Cancel")}
              </Dialog.Close>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveAlias()}
                className="rounded-sm border border-[var(--console-accent)] bg-[var(--console-accent)] px-3 py-1.5 text-xs text-[var(--console-accent-fg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? t("Saving…") : t("Save title")}
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
