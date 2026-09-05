import type { TimeWindowPreset } from "../../lib/time-window";

/** The range pills 3a exposes; a second view of the app's time-window presets. */
export const OVERVIEW_RANGE_PRESETS: readonly { value: TimeWindowPreset; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];
