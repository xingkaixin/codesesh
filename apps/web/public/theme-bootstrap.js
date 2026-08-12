// Runs before first paint so the pre-hydration shell uses the persisted theme.
(() => {
  let theme = "system";
  try {
    const raw = window.localStorage.getItem("codesesh.ui-preferences");
    if (raw) {
      const envelope = JSON.parse(raw);
      const stored = envelope?.version === 1 ? envelope.state?.theme : undefined;
      if (stored === "light" || stored === "dark" || stored === "system") theme = stored;
    }
  } catch {
    theme = "system";
  }

  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  if (theme === "dark" || (theme === "system" && prefersDark)) {
    document.documentElement.classList.add("dark");
  }
})();
