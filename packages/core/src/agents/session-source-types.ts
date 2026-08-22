import type { SessionHead } from "../types/index.js";

export interface SessionCacheMeta {
  id: string;
  sourcePath: string;
  unpricedModels?: string[];
  pricingCaptureEpoch?: string;
  [key: string]: unknown;
}

export interface AgentScanOptions {
  from?: number;
  to?: number;
  fast?: boolean;
  includeRelatedSessions?: boolean;
  onProgress?: (progress: AgentScanProgress) => void;
}

export interface AgentScanProgress {
  phase?: "scanning" | "finalizing";
  total?: number;
  processed?: number;
  sessions?: number;
}

export interface SessionSourceRef {
  sessionId: string;
  sourcePath: string;
  fingerprint: string;
}

export interface SessionSourceFailure {
  sessionId: string;
  sourcePath: string;
  stage: "enumeration" | "parsing";
  errorClass: string;
  message: string;
}

export type SessionSourceOutcome =
  | { status: "parsed"; session: SessionHead; source: SessionSourceRef }
  | { status: "filtered"; reason: string; source: SessionSourceRef }
  | { status: "missing"; source: SessionSourceRef }
  | { status: "failed"; failure: SessionSourceFailure };

export type SessionSourceAbsenceOutcome = Extract<
  SessionSourceOutcome,
  { status: "missing" | "failed" }
>;

export interface SessionSourceScanBatch {
  sources: SessionSourceRef[];
  outcomes: SessionSourceOutcome[];
  sessions: SessionHead[];
}

export interface SessionSourceDiff {
  changedIds: string[];
  removedIds: string[];
  failedIds: string[];
  sourceOutcomes: SessionSourceAbsenceOutcome[];
}

export type SessionCacheMetaSnapshot = Readonly<Record<string, SessionCacheMeta>>;
