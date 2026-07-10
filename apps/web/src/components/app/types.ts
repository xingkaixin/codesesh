/**
 * Shared types for the app-shell subcomponents (search panel, sidebar, filters).
 */
import type { FileActivityKind, ProjectIdentityKind, SmartTag } from "../../lib/api";

export type BrowseBy = "agents" | "projects";

export type CostRangeId = "paid" | "one_plus" | "ten_plus";

export interface SearchFilterState {
  agent?: string;
  project?: {
    kind: ProjectIdentityKind;
    key: string;
  };
  tag?: SmartTag;
  tool?: string;
  fileKind?: FileActivityKind;
  costRange?: CostRangeId;
}

export interface SearchProjectOption {
  key: string;
  identityKind: ProjectIdentityKind;
  identityKey: string;
  label: string;
  count: number;
  showCount?: boolean;
}
