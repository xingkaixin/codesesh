/**
 * DeepSeek Harness (DSH) adapter.
 *
 * Enumeration walks the two-level `sessions/<project-key>/<session-id>/` layout
 * DSH writes. The project key is deliberately lossy — separators collapse and
 * long paths truncate — so it is used only to find candidates; the header's own
 * `id` and `cwd` are the identity, and every artifact must sit exactly where
 * those fields say it does.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import {
  FileSystemSessionSource,
  SessionScanError,
  filteredSession,
  getParsedSession,
  matchesScanWindow,
  parsedSession,
} from "./base.js";
import type {
  AgentScanOptions,
  ParseSessionResult,
  SessionCacheMeta,
  SessionSourceRef,
  SessionWatchPlan,
} from "./base.js";
import type { SessionDetail, SessionHead } from "../types/index.js";
import { basenameTitle, resolveSessionTitle } from "../utils/title-fallback.js";
import {
  DshSessionLogError,
  dshAttachmentsRoot,
  dshFileIdentity,
  dshLogFileName,
  dshLogPath,
  dshSessionsRoot,
  readDshSessionHeader,
  readDshSessionLog,
  resolveDshDataRoot,
  type DshEncoding,
  type DshSessionHeader,
} from "./dsh-session-log.js";
import { projectDshSession, type DshProjection } from "./dsh-transcript.js";

export { resolveDshDataRoot } from "./dsh-session-log.js";

/** Bump when event mapping, packed-row handling or token semantics change. */
const PARSER_REVISION = "dsh-parser-v1";

const ENCODINGS: readonly DshEncoding[] = ["zstd", "none"];

interface DshSessionMeta extends SessionCacheMeta {
  id: string;
  sourcePath: string;
  sourceFingerprint: string;
  sourceMtimeMs: number;
  encoding: DshEncoding;
  directory: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  parentSessionId: string | null;
}

/** One candidate artifact found by walking the session root. */
interface DshArtifact {
  sourcePath: string;
  encoding: DshEncoding;
}

interface ParsedDshSession {
  header: DshSessionHeader;
  projection: DshProjection;
}

function encodingOfPath(sourcePath: string): DshEncoding {
  return basename(sourcePath) === dshLogFileName("zstd") ? "zstd" : "none";
}

/** Two spellings of one physical file (a casing alias) are the same artifact. */
function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

const AGENT_METADATA = getAgentCatalogEntry("dsh");

export class DshAgent extends FileSystemSessionSource<DshSessionMeta> {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;

  getSessionWatchPlan(): SessionWatchPlan {
    const dataRoot = resolveDshDataRoot();
    return {
      status: "supported",
      targets: [{ root: dataRoot, path: dshSessionsRoot(dataRoot) }],
    };
  }

  isAvailable(): boolean {
    try {
      return this.listArtifacts().length > 0;
    } catch {
      // A permission error, mixed encoding or legacy layout is a scan failure
      // to report, never proof that the agent has no data.
      return true;
    }
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    const sessionsRoot = dshSessionsRoot(resolveDshDataRoot());
    const refs: SessionSourceRef[] = [];
    const seenIds = new Map<string, string>();

    for (const artifact of this.listArtifacts()) {
      const stats = this.statArtifact(artifact.sourcePath);
      if (!stats) continue;
      if (!matchesScanWindow(Number(stats.mtimeMs), options)) continue;

      const header = this.scanStep("reading session headers", artifact.sourcePath, () =>
        readDshSessionHeader(artifact.sourcePath, artifact.encoding),
      );
      this.assertStoredIdentity(sessionsRoot, artifact, header);

      const previous = seenIds.get(header.id);
      if (previous) {
        throw new SessionScanError(this.name, "enumerating session sources", {
          cause: new DshSessionLogError(
            `duplicate DSH session id ${JSON.stringify(header.id)} in ${JSON.stringify(previous)} and ${JSON.stringify(artifact.sourcePath)}`,
          ),
          sourcePath: artifact.sourcePath,
        });
      }
      seenIds.set(header.id, artifact.sourcePath);

      refs.push({
        sessionId: header.id,
        sourcePath: artifact.sourcePath,
        fingerprint: JSON.stringify([
          PARSER_REVISION,
          artifact.encoding,
          ...dshFileIdentity(stats),
        ]),
      });
    }

    return refs;
  }

  /** The scan window is applied during enumeration, so parsing needs no options. */
  scanSessionSource(sourcePath: string): SessionHead | null {
    return getParsedSession(
      this.scanSessionSourceResult({ sessionId: "", sourcePath, fingerprint: "" }),
    );
  }

  protected override scanSessionSourceResult(
    source: SessionSourceRef,
  ): ParseSessionResult<SessionHead> {
    const encoding = encodingOfPath(source.sourcePath);
    const { header, projection } = this.parseSession(source.sourcePath, encoding);
    if (projection.messages.length === 0) {
      return filteredSession("no visible messages");
    }

    const head: SessionHead = {
      id: header.id,
      slug: this.sessionSlug(header.id),
      title: this.resolveTitle(header, projection),
      directory: header.cwd ?? "",
      ...(header.parentSession
        ? { parent_reference: { agentName: this.name, sessionId: header.parentSession } }
        : {}),
      time_created: header.createdAt,
      time_updated: projection.updatedAt,
      stats: projection.stats,
      ...(Object.keys(projection.modelUsage).length > 0
        ? { model_usage: projection.modelUsage }
        : {}),
    };

    this.sessionMetaMap.set(head.id, {
      id: head.id,
      sourcePath: source.sourcePath,
      sourceFingerprint: JSON.stringify([
        PARSER_REVISION,
        encoding,
        ...dshFileIdentity(statSync(source.sourcePath, { bigint: true })),
      ]),
      sourceMtimeMs: statSync(source.sourcePath).mtimeMs,
      encoding,
      directory: head.directory,
      title: head.title,
      createdAt: head.time_created,
      updatedAt: projection.updatedAt,
      messageCount: projection.messages.length,
      parentSessionId: header.parentSession ?? null,
    });

    return parsedSession(head);
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    const { header, projection } = this.parseSession(meta.sourcePath, meta.encoding);
    return {
      reference: { agentName: this.name, sessionId: header.id },
      id: header.id,
      title: this.resolveTitle(header, projection),
      slug: this.sessionSlug(header.id),
      directory: header.cwd ?? "",
      ...(header.parentSession
        ? { parent_reference: { agentName: this.name, sessionId: header.parentSession } }
        : {}),
      version: "0",
      time_created: header.createdAt,
      time_updated: projection.updatedAt,
      stats: projection.stats,
      messages: projection.messages,
    };
  }

  /**
   * A cached head with no visible messages was materialized from context-only
   * events; dropping it keeps blank sessions out of the list after a restart.
   */
  override filterCachedSessions(sessions: SessionHead[]): SessionHead[] {
    return sessions.filter((session) => session.stats.message_count > 0);
  }

  private parseSession(sourcePath: string, encoding: DshEncoding): ParsedDshSession {
    const dataRoot = resolveDshDataRoot();
    const { header, events } = readDshSessionLog(sourcePath, encoding);
    return {
      header,
      projection: projectDshSession({
        header,
        events,
        sourcePath,
        attachmentsRoot: dshAttachmentsRoot(dataRoot),
      }),
    };
  }

  private resolveTitle(header: DshSessionHeader, projection: DshProjection): string {
    return resolveSessionTitle(projection.title, null, basenameTitle(header.cwd ?? null));
  }

  /**
   * Walk `sessions/<project>/<session>/` and reject the layouts DSH itself
   * refuses: a flat pre-directory artifact, and a root or session directory
   * holding both physical encodings (which one is current is unknowable).
   */
  private listArtifacts(): DshArtifact[] {
    const sessionsRoot = dshSessionsRoot(resolveDshDataRoot());
    const artifacts: DshArtifact[] = [];
    let rootEncoding: DshEncoding | null = null;

    for (const project of this.listDirectories(sessionsRoot, true)) {
      this.rejectLegacyLayout(project);
      for (const sessionDir of this.listDirectories(project, false)) {
        const present = ENCODINGS.filter((encoding) =>
          existsSync(join(sessionDir, dshLogFileName(encoding))),
        );
        if (present.length === 0) continue;
        if (present.length > 1) {
          this.rejectEnumeration(
            sessionDir,
            `session directory ${JSON.stringify(sessionDir)} holds both physical encodings`,
          );
        }
        const encoding = present[0] as DshEncoding;
        if (rootEncoding !== null && rootEncoding !== encoding) {
          this.rejectEnumeration(
            sessionDir,
            `session root ${JSON.stringify(sessionsRoot)} mixes ${rootEncoding} and ${encoding} artifacts`,
          );
        }
        rootEncoding = encoding;
        artifacts.push({ sourcePath: join(sessionDir, dshLogFileName(encoding)), encoding });
      }
    }

    return artifacts;
  }

  private listDirectories(directory: string, tolerateMissing: boolean): string[] {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name));
    } catch (error) {
      // Only an absent session root means "no DSH data"; every other I/O
      // failure must surface so a readable baseline is not discarded.
      if (tolerateMissing && isMissingDirectory(error)) return [];
      throw new SessionScanError(this.name, "enumerating session sources", {
        cause: error,
        sourcePath: directory,
      });
    }
  }

  private rejectLegacyLayout(project: string): void {
    const legacy = readdirSync(project, { withFileTypes: true }).find(
      (entry) =>
        entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zstd")),
    );
    if (!legacy) return;
    this.rejectEnumeration(
      join(project, legacy.name),
      `session artifact ${JSON.stringify(join(project, legacy.name))} uses the unsupported flat-file layout`,
    );
  }

  /** The header's id and cwd must name exactly the artifact they were read from. */
  private assertStoredIdentity(
    sessionsRoot: string,
    artifact: DshArtifact,
    header: DshSessionHeader,
  ): void {
    let expected: string;
    try {
      expected = dshLogPath(sessionsRoot, header.cwd, header.id, artifact.encoding);
    } catch (error) {
      this.rejectEnumeration(
        artifact.sourcePath,
        `header id ${JSON.stringify(header.id)} cannot name a storage path`,
        error,
      );
    }
    if (!sameFile(artifact.sourcePath, expected)) {
      this.rejectEnumeration(
        artifact.sourcePath,
        `header identifies ${JSON.stringify(expected)}, not ${JSON.stringify(artifact.sourcePath)}`,
      );
    }
  }

  private statArtifact(sourcePath: string) {
    try {
      return statSync(sourcePath, { bigint: true });
    } catch (error) {
      if (isMissingDirectory(error)) return null;
      throw new SessionScanError(this.name, "reading session source metadata", {
        cause: error,
        sourcePath,
      });
    }
  }

  private rejectEnumeration(sourcePath: string, reason: string, cause?: unknown): never {
    throw new SessionScanError(this.name, "enumerating session sources", {
      cause: new DshSessionLogError(reason, cause ? { cause } : undefined),
      sourcePath,
    });
  }
}

function isMissingDirectory(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
