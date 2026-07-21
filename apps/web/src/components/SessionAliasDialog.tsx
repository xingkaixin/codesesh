import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";

export interface SessionAliasTarget {
  agentKey: string;
  sessionId: string;
  title: string;
  displayTitle?: string;
}

export function SessionAliasDialog({
  target,
  onClose,
  onSave,
  onRemove,
}: {
  target: SessionAliasTarget | null;
  onClose: () => void;
  onSave: (alias: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAlias(target?.displayTitle ?? target?.title ?? "");
    setError(null);
  }, [target]);

  const saveAlias = async () => {
    const nextAlias = alias.trim();
    if (!nextAlias || nextAlias === target?.title.trim()) {
      await removeAlias();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(nextAlias);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not rename this session.");
    } finally {
      setSaving(false);
    }
  };

  const removeAlias = async () => {
    setSaving(true);
    setError(null);
    try {
      await onRemove();
      onClose();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not restore the title.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={target !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="motion-backdrop fixed inset-0 z-50 bg-black/35" />
        <Dialog.Popup className="motion-modal fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] p-5 shadow-2xl outline-none">
          <Dialog.Title className="console-mono text-sm font-semibold text-[var(--console-text)]">
            Rename session
          </Dialog.Title>
          <label className="console-mono mt-4 block text-[11px] uppercase tracking-wide text-[var(--console-muted)]">
            Session title
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
              className="mt-1.5 w-full rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--console-text)] outline-none focus:border-[var(--console-accent)] focus:ring-2 focus:ring-[var(--console-accent)]/25"
            />
          </label>
          {error ? (
            <p
              id="session-alias-error"
              aria-live="polite"
              className="mt-2 text-xs text-[var(--console-error)]"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => void removeAlias()}
              disabled={saving || !target?.displayTitle}
              className="text-xs text-[var(--console-muted)] underline decoration-[var(--console-border-strong)] underline-offset-4 hover:text-[var(--console-text)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Remove custom title
            </button>
            <div className="flex items-center gap-2">
              <Dialog.Close className="rounded-sm border border-[var(--console-border)] px-3 py-1.5 text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)]">
                Cancel
              </Dialog.Close>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveAlias()}
                className="rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-text)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save title"}
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
