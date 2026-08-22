import type { SessionCacheMeta } from "../../agents/session-source-types.js";

const DETAIL_PROJECTION_VERSION = "session-detail-v1";

export function sessionDetailVersion(meta: SessionCacheMeta | null | undefined): string {
  const parserVersions = Object.entries(meta ?? {})
    .filter(
      ([key, value]) => key.toLowerCase().endsWith("parserversion") && typeof value === "string",
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    DETAIL_PROJECTION_VERSION,
    typeof meta?.sourceFingerprint === "string" ? meta.sourceFingerprint : null,
    parserVersions,
  ]);
}
