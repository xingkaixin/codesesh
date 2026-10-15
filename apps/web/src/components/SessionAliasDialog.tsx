import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import {
  BUTTON_GHOST_CLASS,
  BUTTON_OUTLINE_CLASS,
  BUTTON_PRIMARY_CLASS,
  DIALOG_BODY_CLASS,
  DIALOG_DESCRIPTION_CLASS,
  DIALOG_FOOTER_CLASS,
  DIALOG_HEADER_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_TITLE_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
} from "./ui/dialog-styles";

export interface SessionAliasTarget {
  sourceNodeId?: string;
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
        <Dialog.Popup className={`${DIALOG_POPUP_CLASS} max-w-[440px]`}>
          <div className={DIALOG_HEADER_CLASS}>
            <div>
              <Dialog.Title className={DIALOG_TITLE_CLASS}>{t("Rename session")}</Dialog.Title>
              <Dialog.Description className={DIALOG_DESCRIPTION_CLASS}>
                {t("Custom titles stay in CodeSesh and never change the original session file.")}
              </Dialog.Description>
            </div>
          </div>
          <div className={DIALOG_BODY_CLASS}>
            <label className={FIELD_LABEL_CLASS}>
              {t("Session title")}
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
                className={INPUT_CLASS}
              />
            </label>
            <span className="console-mono -mt-2.5 self-end text-[11px] text-[var(--console-muted)]">
              {alias.length} / 160
            </span>
            {error ? (
              <p
                id="session-alias-error"
                aria-live="polite"
                className="-mt-2 text-xs text-[var(--console-error)]"
              >
                {t(error)}
              </p>
            ) : null}
          </div>
          <div className={`${DIALOG_FOOTER_CLASS} justify-between`}>
            <button
              type="button"
              onClick={() => void removeAlias()}
              disabled={saving || !target?.displayTitle}
              className={`${BUTTON_GHOST_CLASS} text-[var(--console-error)]`}
            >
              {t("Remove custom title")}
            </button>
            <div className="flex items-center gap-2">
              <Dialog.Close className={BUTTON_OUTLINE_CLASS}>{t("Cancel")}</Dialog.Close>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveAlias()}
                className={BUTTON_PRIMARY_CLASS}
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
