import type { ScanStatusEvent, SessionsUpdatedEvent } from "@codesesh/core/contract";

export interface ScanEventSource {
  getScanStatus(): ScanStatusEvent;
  subscribe(listener: (event: SessionsUpdatedEvent) => void): () => void;
  subscribeScanStatus(listener: (event: ScanStatusEvent) => void): () => void;
}
