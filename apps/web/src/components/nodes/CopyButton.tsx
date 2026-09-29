import { useEffect, useState } from "react";
import { t } from "../../i18n/translate";
import { writeToClipboard } from "../../lib/clipboard";
import { Check, Copy } from "../ui/icons";
import { nodeButton } from "./NodeDialog";

export function CopyButton({
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
