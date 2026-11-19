export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = "text/markdown;charset=utf-8",
): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
    return false;
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
    return true;
  } finally {
    document.body.removeChild(link);
    // Defer revocation so browsers finish initiating the download first.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
