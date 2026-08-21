import type { LiveSnapshot } from "@codesesh/core/runtime";
import type { ScanStatusEvent } from "@codesesh/core/contract";

export interface ScanResultSource {
  getSnapshot(): LiveSnapshot;
}

export interface ScanStatusSource {
  getScanStatus(): ScanStatusEvent;
}
