import { trackEvent } from "./analytics";

const INSTALL_COMMAND_RE = /\b(codesesh|install\.sh|brew\s+install|scoop\s+install)\b/;

export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      document.body.append(textarea);
      textarea.select();
      // Isolate the deprecated API retained for Clipboard API failures.
      const legacyDocument: {
        execCommand?: (command: "copy") => boolean;
      } = document;
      const copied =
        typeof legacyDocument.execCommand === "function" &&
        legacyDocument.execCommand("copy") === true;
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

export function bindCopyButtons() {
  const status = document.querySelector<HTMLElement>("[data-copy-value-status]");
  document.querySelectorAll<HTMLButtonElement>("[data-copy-value]").forEach((button) => {
    const text = button.querySelector<HTMLElement>("[data-copy-text]");
    const icons = button.querySelectorAll<HTMLElement>("[data-copy-icon]");
    const showIcon = (name: string) =>
      icons.forEach((icon) => {
        icon.dataset.active = String(icon.dataset.copyIcon === name);
      });
    let timer = 0;

    button.addEventListener("click", async () => {
      const value = button.dataset.copyValue ?? "";
      const copied = await copyText(value);
      const feedback = (copied ? button.dataset.copiedLabel : button.dataset.copyFailedLabel) ?? "";
      if (text) text.textContent = feedback;
      if (status) status.textContent = feedback;
      showIcon(copied ? "done" : "idle");
      if (copied) {
        const isInstall = INSTALL_COMMAND_RE.test(value);
        void trackEvent(isInstall ? "install-copy" : "guide-copy", {
          method: isInstall ? "guide" : "command",
          placement: window.location.pathname,
        });
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (text) text.textContent = button.dataset.copyLabel ?? "";
        showIcon("idle");
      }, 1600);
    });
  });
}
