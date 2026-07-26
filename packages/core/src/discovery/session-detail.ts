import type { SessionCacheMeta } from "../agents/index.js";
import type { SessionData } from "../types/index.js";
import { computeIdentity, realFs } from "../projects/index.js";
import {
  classifySessionTags,
  extractSessionFileActivity,
  getSmartTagSourceTimestamp,
} from "../utils/index.js";
import { listSessionFileActivity, loadCachedSessionDataEntry } from "./cache.js";
import type { ScanResult } from "./scanner.js";

export interface SessionReference {
  agentName: string;
  sessionId: string;
}

export type SessionDetailResult =
  | { status: "found"; data: SessionData }
  | { status: "unknown-agent" }
  | { status: "not-ready" };

function cacheMatchesCurrentSource(
  cachedMeta: SessionCacheMeta | null,
  currentMeta: SessionCacheMeta | undefined,
): boolean {
  const currentFingerprint = currentMeta?.sourceFingerprint;
  if (typeof currentFingerprint !== "string") return true;
  return cachedMeta?.sourceFingerprint === currentFingerprint;
}

function cacheHasCompleteDetail(
  cachedData: SessionData | null,
  cachedMeta: SessionCacheMeta | null,
  currentMeta: SessionCacheMeta | undefined,
): cachedData is SessionData {
  if (!cachedData || !cacheMatchesCurrentSource(cachedMeta, currentMeta)) {
    return false;
  }

  return cachedData.messages.length > 0 || cachedData.stats.message_count === 0;
}

export function materializeSessionDetail(
  scanResult: ScanResult,
  reference: SessionReference,
): SessionDetailResult {
  const agent = scanResult.agents.find((item) => item.name === reference.agentName);
  if (!agent) {
    return { status: "unknown-agent" };
  }

  const head = scanResult.byAgent[reference.agentName]?.find(
    (item) => item.id === reference.sessionId,
  );
  const cachedEntry = loadCachedSessionDataEntry(reference.agentName, reference.sessionId);
  const cachedData = cachedEntry?.data ?? null;
  const currentMeta = head ? agent.getSessionMetaMap().get(reference.sessionId) : undefined;
  const useCache = cacheHasCompleteDetail(cachedData, cachedEntry?.meta ?? null, currentMeta);
  const data = useCache ? cachedData : head ? agent.getSessionData(reference.sessionId) : null;

  if (!data) {
    return { status: "not-ready" };
  }

  const projectIdentity =
    data.project_identity ?? head?.project_identity ?? computeIdentity(data.directory, realFs);
  const fileActivity =
    data.file_activity ??
    (useCache
      ? listSessionFileActivity(reference.agentName, reference.sessionId)
      : extractSessionFileActivity(
          reference.agentName,
          reference.sessionId,
          projectIdentity.key,
          data.messages,
        ));

  return {
    status: "found",
    data: {
      ...data,
      project_identity: projectIdentity,
      smart_tags: data.smart_tags ?? classifySessionTags(data),
      smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
      file_activity: fileActivity,
    },
  };
}
