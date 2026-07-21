/**
 * Injectable diagnostics sink for core's failure paths. core stays
 * framework-agnostic (no logger dependency); hosts opt in by calling
 * setCoreDiagnostics once at startup. Default is a silent no-op so core's
 * behavior is unchanged for consumers that never inject one.
 */

export interface CoreDiagnostics {
  warn(event: string, detail?: Record<string, unknown>): void;
}

let diagnostics: CoreDiagnostics | null = null;

/**
 * A host-injected sink that throws must not escape into core's own control
 * flow — e.g. abort a `FileSystemSessionSource.scan` loop or turn a cache
 * write's `catch { return null }` into an uncaught throw. Wrap once here so
 * every `diagnostics?.warn(...)` call site stays exception-safe for free.
 */
function toSafeSink(sink: CoreDiagnostics): CoreDiagnostics {
  return {
    warn(event, detail) {
      try {
        sink.warn(event, detail);
      } catch {}
    },
  };
}

export function setCoreDiagnostics(next: CoreDiagnostics | null): void {
  diagnostics = next ? toSafeSink(next) : null;
}

export function getCoreDiagnostics(): CoreDiagnostics | null {
  return diagnostics;
}
