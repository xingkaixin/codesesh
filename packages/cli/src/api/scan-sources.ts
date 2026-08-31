import type { LiveSnapshot, SessionQueryScope } from "@codesesh/core/runtime/discovery";
import type { ScanStatusEvent } from "@codesesh/core/contract";

export interface ScanResultSource {
  readonly queryScope?: SessionQueryScope;
  getSnapshot(): LiveSnapshot;
}

export interface ScanStatusSource {
  getScanStatus(): ScanStatusEvent;
}
