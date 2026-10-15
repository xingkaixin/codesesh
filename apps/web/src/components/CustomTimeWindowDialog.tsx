import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import { formatIsoDate } from "../lib/scan-format";
import type { TimeWindow } from "../lib/time-window";
import {
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

export function CustomTimeWindowDialog({
  open,
  onOpenChange,
  window,
  customFrom,
  customTo,
  onSelectCustom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  window: TimeWindow | null;
  customFrom?: string;
  customTo?: string;
  onSelectCustom: (from: string, to: string) => void;
}) {
  useLocale();

  const initialFrom = customFrom ?? (window?.from != null ? formatIsoDate(window.from) : "");
  const initialTo = customTo ?? (window?.to != null ? formatIsoDate(window.to) : null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open ? (
        <CustomTimeWindowDialogContent
          initialFrom={initialFrom}
          initialTo={initialTo}
          onOpenChange={onOpenChange}
          onSelectCustom={onSelectCustom}
        />
      ) : null}
    </Dialog.Root>
  );
}

function CustomTimeWindowDialogContent({
  initialFrom,
  initialTo,
  onOpenChange,
  onSelectCustom,
}: {
  initialFrom: string;
  initialTo: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectCustom: (from: string, to: string) => void;
}) {
  useLocale();

  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(() => initialTo ?? formatIsoDate(Date.now()));

  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="motion-backdrop fixed inset-0 z-50 bg-[var(--scrim)]" />
      <Dialog.Popup className={`${DIALOG_POPUP_CLASS} max-w-[440px]`}>
        <div className={DIALOG_HEADER_CLASS}>
          <div>
            <Dialog.Title className={DIALOG_TITLE_CLASS}>{t("Custom time range")}</Dialog.Title>
            <Dialog.Description className={DIALOG_DESCRIPTION_CLASS}>
              {t("Both dates are included.")}
            </Dialog.Description>
          </div>
        </div>
        <div className={DIALOG_BODY_CLASS}>
          <div className="grid grid-cols-2 gap-3">
            <label className={FIELD_LABEL_CLASS}>
              {t("From")}
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => setFrom(event.target.value)}
                className={`${INPUT_CLASS} console-mono`}
              />
            </label>
            <label className={FIELD_LABEL_CLASS}>
              {t("To")}
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
                className={`${INPUT_CLASS} console-mono`}
              />
            </label>
          </div>
        </div>
        <div className={DIALOG_FOOTER_CLASS}>
          <Dialog.Close className={BUTTON_OUTLINE_CLASS}>{t("Cancel")}</Dialog.Close>
          <button
            type="button"
            disabled={!from || !to || from > to}
            onClick={() => {
              onSelectCustom(from, to);
              onOpenChange(false);
            }}
            className={BUTTON_PRIMARY_CLASS}
          >
            {t("Apply range")}
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}
