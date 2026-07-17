import { useCallback, useEffect, useState } from "react";
import { type ScanStatusEvent, fetchScanStatus } from "../lib/api";

/**
 * Owns scan-status state: fetches the initial snapshot on mount and exposes
 * setScanStatus so the live subscription can push SSE events in.
 */
export function useScanStatus() {
  const [scanStatus, setScanStatusState] = useState<ScanStatusEvent | null>(null);

  // The mount-time snapshot fetch races with SSE events; without this guard a
  // stale snapshot resolving late can overwrite fresher state and freeze the
  // scanning indicator until the next unrelated event arrives.
  const setScanStatus = useCallback((next: ScanStatusEvent) => {
    setScanStatusState((prev) => (prev && next.updatedAt < prev.updatedAt ? prev : next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchScanStatus()
      .then((status) => {
        if (!cancelled) setScanStatus(status);
      })
      .catch((err) => {
        console.error("Failed to load scan status:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [setScanStatus]);

  return { scanStatus, setScanStatus };
}
