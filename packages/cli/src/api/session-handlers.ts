import { toPublicSessionHead, type SessionReference } from "@codesesh/core/contract";
import {
  materializeSessionDetailResponse,
  type SessionHead,
  type SmartTag,
} from "@codesesh/core/runtime/discovery";
import {
  matchesProjectIdentity,
  matchesProjectScope as sessionMatchesProjectScope,
  type ProjectScopeMatcher,
} from "@codesesh/core/runtime/projects";
import type { Context } from "hono";
import { appLogger } from "../logging.js";
import type { ProjectIdentityResolver } from "../project-identity-resolver.js";
import { SessionDetailBusyError, type SessionDetailLoader } from "../session-detail-loader.js";
import {
  KNOWN_AGENT_NAMES,
  parseDateWindowRequest,
  projectScopeResolutionFailureResponse,
  reportInvalidQueryParameter,
  resolveProjectScope,
} from "./handler-support.js";
import {
  filterSessionsByActivityWindow,
  optionalQueryValue,
  parseProjectIdentityFilter,
  parseSessionQuery,
  searchParams,
  SESSION_PAGE_LIMIT_POLICY,
  type SessionListDefaults,
} from "./query-params.js";
import type { ScanResultSource } from "./scan-sources.js";
import { createSessionDetailJsonResponse } from "./session-detail-stream.js";
import { loadAliasView } from "./session-aliases-view.js";
import { paginateSnapshot } from "./snapshot-pagination.js";
import { getSnapshotAggregation } from "./snapshot-aggregation.js";

function getSessionHeadReference(session: SessionHead): SessionReference {
  return session.reference;
}

export async function handleGetSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
  resolver?: ProjectIdentityResolver,
) {
  const scanResult = scanSource.getSnapshot();
  const params = searchParams(c);
  const paginationRequested = params.has("limit") || params.has("cursor");
  const sessionQuery = parseSessionQuery(params, KNOWN_AGENT_NAMES, SESSION_PAGE_LIMIT_POLICY);
  if (sessionQuery.limit.kind === "invalid") {
    reportInvalidQueryParameter("sessions", "limit", "rejected");
    return c.json({ error: sessionQuery.limit.error }, 400);
  }
  const q = c.req.query("q")?.toLowerCase();
  const cwd = optionalQueryValue(c.req.query("cwd"));
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const tag = c.req.query("tag")?.toLowerCase();
  const window = parseDateWindowRequest(c, "sessions", defaults);
  if (window.kind === "rejected") return window.response;
  const { from, to } = window;

  let projectScope: ProjectScopeMatcher | undefined;
  if (cwd && !projectIdentity) {
    try {
      projectScope = await resolveProjectScope(
        cwd,
        scanResult.sessions,
        resolver,
        c.req.raw.signal,
      );
    } catch (error) {
      return projectScopeResolutionFailureResponse(c, "sessions", error);
    }
  }

  if (sessionQuery.agent.kind === "unknown") {
    reportInvalidQueryParameter("sessions", "agent", "empty_result");
  }

  const agentFilter =
    sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : sessionQuery.agent.kind;
  let sessions = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    [
      "sessions",
      agentFilter,
      projectIdentity?.kind,
      projectIdentity?.key,
      projectScope?.identity.kind,
      projectScope?.identity.key,
      projectScope?.path,
      tag,
      from,
      to,
    ],
    () => {
      let filtered =
        sessionQuery.agent.kind === "all"
          ? scanResult.sessions
          : sessionQuery.agent.kind === "known"
            ? (scanResult.byAgent[sessionQuery.agent.agentName] ?? [])
            : [];

      if (projectIdentity) {
        filtered = filtered.filter((session) =>
          matchesProjectIdentity(session.project_identity, projectIdentity),
        );
      } else if (projectScope) {
        filtered = filtered.filter((session) => sessionMatchesProjectScope(session, projectScope));
      }
      filtered = filterSessionsByActivityWindow(filtered, from, to);
      return tag
        ? filtered.filter((session) => session.smart_tags?.includes(tag as SmartTag))
        : filtered;
    },
  );

  const aliases = loadAliasView();
  if (q) {
    sessions = sessions.filter((session) => {
      const alias = aliases.get(getSessionHeadReference(session));
      return session.title.toLowerCase().includes(q) || alias?.toLowerCase().includes(q);
    });
  }

  if (paginationRequested) {
    const page = paginateSnapshot(sessions, {
      cursor: params.get("cursor") ?? undefined,
      limit: sessionQuery.limit.value,
      query: params,
      snapshotIdentity: scanResult.sessions,
      viewIdentity: aliases,
    });
    if (page.kind === "invalid_cursor") {
      reportInvalidQueryParameter("sessions", "cursor", "rejected");
      return c.json({ error: "cursor is invalid for this request" }, 400);
    }
    if (page.kind === "stale_snapshot") {
      return c.json({ error: "session snapshot changed; restart pagination" }, 409);
    }
    return c.json({
      sessions: page.items.map((session) =>
        toPublicSessionHead(aliases.decorate(session, getSessionHeadReference(session))),
      ),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  return c.json({
    sessions: sessions.map((session) =>
      toPublicSessionHead(aliases.decorate(session, getSessionHeadReference(session))),
    ),
  });
}

export async function handleGetSessionData(
  c: Context,
  scanSource: ScanResultSource,
  loadDetail: SessionDetailLoader = materializeSessionDetailResponse,
) {
  const startedAt = performance.now();
  const agentName = c.req.param("agent");
  const sessionId = c.req.param("id");

  if (!agentName) return c.json({ error: "Missing agent name" }, 400);
  if (!sessionId) return c.json({ error: "Missing session ID" }, 400);

  try {
    const reference = { agentName, sessionId };
    const messageCursor = optionalQueryValue(c.req.query("messageCursor"));
    const result = await loadDetail(
      scanSource.getSnapshot(),
      reference,
      messageCursor ? { messageCursor } : {},
      c.req.raw.signal,
    );
    if (result.status === "unknown-agent") {
      return c.json({ error: `Unknown agent: ${agentName}` }, 404);
    }
    if (result.status === "not-ready") {
      appLogger.warn("api.session_data.cache_miss", {
        agent: agentName,
        session_id: sessionId,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      return c.json({ error: "Session cache not ready" }, 404);
    }

    appLogger.info("api.session_data", {
      agent: agentName,
      session_id: sessionId,
      messages: result.status === "found-json" ? result.messageCount : result.data.messages.length,
      sent_messages:
        result.status === "found-json" ? result.sentMessageCount : result.data.messages.length,
      message_update: result.data.message_update ?? "reset",
      duration_ms: Math.round(performance.now() - startedAt),
    });
    const aliases = loadAliasView();
    if (result.status === "found-json") {
      return createSessionDetailJsonResponse(
        aliases.decorate(result.data, result.data.reference),
        result.messages,
      );
    }
    return c.json(aliases.decorate(result.data, result.data.reference));
  } catch (error) {
    if (error instanceof SessionDetailBusyError) {
      c.header("Retry-After", "1");
      return c.json({ error: "Session details busy; retry later" }, 503);
    }
    const message = error instanceof Error ? error.message : "Failed to load session";
    appLogger.error("api.session_data.error", {
      agent: agentName,
      session_id: sessionId,
      duration_ms: Math.round(performance.now() - startedAt),
      error: message,
    });
    return c.json({ error: "Failed to load session" }, 500);
  }
}
