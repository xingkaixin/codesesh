/**
 * Shared types for the app-shell subcomponents (search panel, sidebar, filters).
 */
import type { FileActivityKind, ProjectIdentityKind, SearchResult, SmartTag } from "../../lib/api";

export type BrowseBy = "agents" | "projects";

export type CostRangeId = "paid" | "one_plus" | "ten_plus";

export type SearchLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; results: SearchResult[] }
  | { status: "failed"; error: string };

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
