/**
 * Shared types for the app-shell subcomponents (search panel, sidebar, filters).
 */
import type { FileActivityKind, SmartTag } from "../../lib/api";

export type BrowseBy = "agents" | "projects";

export type CostRangeId = "paid" | "one_plus" | "ten_plus";

export interface SearchFilterState {
  agent?: string;
  projectKey?: string;
  tag?: SmartTag;
  tool?: string;
  fileKind?: FileActivityKind;
  costRange?: CostRangeId;
}

export interface SearchProjectOption {
  key: string;
  label: string;
  count: number;
  showCount?: boolean;
}
