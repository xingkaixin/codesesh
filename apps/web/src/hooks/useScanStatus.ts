import { useEffect, useState } from "react";
import { type ScanStatusEvent, fetchScanStatus } from "../lib/api";

/**
 * Owns scan-status state: fetches the initial snapshot on mount and exposes
 * setScanStatus so the live-update subscription can push SSE events in.
 */
export function useScanStatus() {
  const [scanStatus, setScanStatus] = useState<ScanStatusEvent | null>(null);

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
  }, []);

  return { scanStatus, setScanStatus };
}
