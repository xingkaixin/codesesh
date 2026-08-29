export type {
  AgentInfo,
  SmartTag,
  FileActivityKind,
  CostSource,
  SessionHead,
  SessionFileActivity,
  FileActivityResult,
  ProjectIdentityKind,
  ProjectIdentity,
  ProjectIdentityRef,
  MessageTokens,
  ToolPartStatus,
  ToolPartState,
  TextPart,
  ReasoningPart,
  PlanPart,
  ImageDataPart,
  ImageUrlPart,
  ImagePart,
  ToolPart,
  MessagePart,
  Message,
  SessionDetail,
  SessionListPage,
  SessionReference,
  ScanStatusEvent,
  BackfillStatus,
  AgentScanStatus,
  DashboardAgentStat,
  DashboardDailyBucket,
  ModelDistributionEntry,
  ModelCostEntry,
  DashboardTotals,
  DashboardPreviousTotals,
  DashboardProjectStat,
  DashboardRecentSession,
  DashboardData,
  AppConfig,
  SearchResult,
  SessionsUpdatedEvent,
  ApiProjectGroup,
  ApiProjectPage,
  ApiProjectSummary,
  ApiProjectAgentStat,
  BookmarkRecord,
  BookmarkView,
} from "@codesesh/core/contract";

export { SMART_TAGS } from "@codesesh/core/contract";

import type {
  FileActivityKind,
  ProjectIdentityKind,
  ProjectIdentityRef,
  SessionHead,
  SmartTag,
} from "@codesesh/core/contract";

export interface SearchRequestOptions {
  agent?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
  tag?: SmartTag;
  tool?: string;
  fileKind?: FileActivityKind;
  costMin?: number;
  costMax?: number;
  from?: number;
  to?: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
}

export interface SessionDetailFetchOptions extends FetchOptions {
  messageCursor?: string;
}

export interface ProjectPageOptions extends FetchOptions {
  cursor?: string;
  project?: ProjectIdentityRef;
}

export interface SessionFetchProgress {
  onFirstPage?: (sessions: SessionHead[]) => void;
}

export interface DashboardFilters {
  project?: { kind: ProjectIdentityKind; key: string };
  agent?: string;
}
