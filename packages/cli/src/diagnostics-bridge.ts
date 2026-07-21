import { setCoreDiagnostics } from "@codesesh/core";
import { appLogger } from "./logging.js";

/**
 * Bridges core's diagnostics sink to appLogger. Import this once, for its
 * side effect, from every entry point that gets its own module graph — the
 * main CLI thread and each worker_threads script (scan-refresh-worker,
 * search-index-worker, smart-tag-worker) — since core's module-level
 * diagnostics singleton is per-thread, not shared across workers.
 */
setCoreDiagnostics({
  warn(event, detail) {
    appLogger.warn(event, detail);
  },
});
