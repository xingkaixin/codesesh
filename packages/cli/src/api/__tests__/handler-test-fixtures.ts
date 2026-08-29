import { afterEach, vi, type Mock } from "vitest";
import { createSessionIdentity } from "@codesesh/core/contract";

type CoreMockName =
  | "attachProjectMetrics"
  | "buildSessionTree"
  | "buildDashboard"
  | "filterSessionSearchCandidates"
  | "getAnalyticsRevision"
  | "materializeSessionDetailResponse"
  | "listDashboardCostFacts"
  | "listFileActivity"
  | "matchesProjectIdentity"
  | "listSessionAliases"
  | "executeSessionSearch";

const coreMocks: Record<CoreMockName, Mock> = vi.hoisted(() => {
  return {
    attachProjectMetrics: vi.fn(),
    buildSessionTree: vi.fn(),
    buildDashboard: vi.fn(),
    filterSessionSearchCandidates: vi.fn(),
    getAnalyticsRevision: vi.fn(() => "0"),
    materializeSessionDetailResponse: vi.fn(),
    listDashboardCostFacts: vi.fn((): DashboardCostFacts | null => null),
    listFileActivity: vi.fn((): FileActivityResult[] => []),
    matchesProjectIdentity: vi.fn(),
    listSessionAliases: vi.fn<
      () => Array<{
        reference: { agentName: string; sessionId: string };
        alias: string;
        updatedAt: number;
      }>
    >(() => []),
    executeSessionSearch: vi.fn(
      (
        _query: string,
        _options?: unknown,
        _scanResult?: unknown,
        _context?: unknown,
      ): Array<{
        reference: { agentName: string; sessionId: string };
        session: SessionHead;
      }> => [],
    ),
  };
});

vi.mock("@codesesh/core/runtime/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime/projects")>();
  return {
    ...actual,
    attachProjectMetrics: (...args: Parameters<typeof actual.attachProjectMetrics>) => {
      coreMocks.attachProjectMetrics(...args);
      return actual.attachProjectMetrics(...args);
    },
    attachProjectMetricsFromTree: (
      ...args: Parameters<typeof actual.attachProjectMetricsFromTree>
    ) => {
      coreMocks.attachProjectMetrics(...args);
      return actual.attachProjectMetricsFromTree(...args);
    },
    matchesProjectIdentity: (...args: Parameters<typeof actual.matchesProjectIdentity>) => {
      coreMocks.matchesProjectIdentity(...args);
      return actual.matchesProjectIdentity(...args);
    },
  };
});

vi.mock("@codesesh/core/runtime/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime/analytics")>();
  return {
    ...actual,
    buildDashboard: (...args: Parameters<typeof actual.buildDashboard>) => {
      coreMocks.buildDashboard(...args);
      return actual.buildDashboard(...args);
    },
  };
});

vi.mock("@codesesh/core/runtime/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime/search")>();
  return {
    ...actual,
    filterSessionSearchCandidates: (
      ...args: Parameters<typeof actual.filterSessionSearchCandidates>
    ) => {
      coreMocks.filterSessionSearchCandidates(...args);
      return actual.filterSessionSearchCandidates(...args);
    },
    executeSessionSearch: coreMocks.executeSessionSearch,
  };
});

vi.mock("@codesesh/core/runtime/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codesesh/core/runtime/discovery")>()),
  getAnalyticsRevision: coreMocks.getAnalyticsRevision,
  listDashboardCostFacts: coreMocks.listDashboardCostFacts,
  materializeSessionDetailResponse: coreMocks.materializeSessionDetailResponse,
  listFileActivity: coreMocks.listFileActivity,
}));

vi.mock("@codesesh/core/runtime/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codesesh/core/runtime/state")>()),
  listSessionAliases: coreMocks.listSessionAliases,
}));

vi.mock("@codesesh/core/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/contract")>();
  return {
    ...actual,
    buildSessionTree: (...args: Parameters<typeof actual.buildSessionTree>) => {
      coreMocks.buildSessionTree(...args);
      return actual.buildSessionTree(...args);
    },
  };
});

import type { ScanResultSource } from "../scan-sources.js";
import { invalidateAliasView } from "../session-aliases-view.js";
import type { ProjectIdentityResolver } from "../../project-identity-resolver.js";
import type { ChangeCheckResult, SessionCacheMeta } from "@codesesh/core/runtime/agents";
import type { DashboardCostFacts } from "@codesesh/core/runtime/analytics";
import type {
  FileActivityResult,
  IdentifiedSessionHead,
  LiveSnapshot,
  SessionHead,
  SessionDetail,
} from "@codesesh/core/runtime/discovery";
import { BaseAgent } from "@codesesh/core/runtime/agents";

// --- Helpers ---

function makeSession(
  id: string,
  overrides?: Partial<IdentifiedSessionHead>,
): IdentifiedSessionHead {
  const identity = createSessionIdentity(
    overrides?.reference ?? { agentName: "agent", sessionId: id },
  );
  const directory = overrides?.directory ?? "/home/user/project";
  return {
    ...identity,
    title: `Session ${id}`,
    time_created: Date.now(),
    time_updated: Date.now(),
    directory,
    project_identity: {
      kind: "path",
      key: directory,
      displayName: "project",
    },
    stats: {
      message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
    ...identity,
  };
}

function makeAlias(agentName: string, sessionId: string, alias: string) {
  return {
    reference: { agentName, sessionId },
    alias,
    updatedAt: 1,
  };
}

function makeMockContext(
  overrides: {
    query?: Record<string, string>;
    param?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) {
  const jsonFn = vi.fn().mockReturnValue({ status: 200 });
  const params = new URLSearchParams(overrides.query ?? {});
  const url = `http://localhost/${params.size ? `?${params.toString()}` : ""}`;
  return {
    req: {
      query: (key: string) => overrides.query?.[key] ?? "",
      param: (key: string) => overrides.param?.[key] ?? "",
      url,
      raw: new Request(url, { signal: overrides.signal }),
    },
    json: jsonFn,
  } as any;
}

class MockAgent extends BaseAgent {
  readonly name = "claudecode";
  readonly displayName = "Claude Code";
  readonly sessionSourceAccess = {
    kind: "aggregate" as const,
    checkForChanges: () => this.checkForChanges(),
    commitChangeCheck: () => {},
    incrementalScan: (sessions: SessionHead[]) => this.incrementalScan(sessions),
  };

  isAvailable() {
    return true;
  }

  scan(): SessionHead[] {
    return [];
  }

  getSessionData(_sessionId: string): SessionDetail {
    return {
      reference: { agentName: "claudecode", sessionId: "s1" },
      title: "Test Session",
      directory: "/home/user/project",
      time_created: 1000,
      time_updated: 1000,
      messages: [],
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    };
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "API test adapter" };
  }

  checkForChanges(): ChangeCheckResult {
    return { hasChanges: false, timestamp: Date.now() };
  }

  incrementalScan(cachedSessions: SessionHead[]): SessionHead[] {
    return cachedSessions;
  }

  getSessionCacheMeta(): SessionCacheMeta | undefined {
    return undefined;
  }

  snapshotSessionCacheMeta(): Record<string, SessionCacheMeta> {
    return {};
  }

  restoreSessionCacheMeta(): void {}

  removeSessionCacheMeta(): void {}
}

function makeScanResult(overrides?: Partial<LiveSnapshot>): LiveSnapshot {
  const agent = new MockAgent();
  const sessions = [
    makeSession("s1", { reference: { agentName: "claudecode", sessionId: "s1" } }),
    makeSession("s2", { reference: { agentName: "claudecode", sessionId: "s2" } }),
  ];
  return {
    sessions,
    byAgent: { claudecode: sessions },
    agents: [agent],
    ...overrides,
  };
}

function makeScanSource(overrides?: Partial<LiveSnapshot>): ScanResultSource {
  const result = makeScanResult(overrides);
  return {
    getSnapshot() {
      return result;
    },
  };
}

function makeProjectIdentityResolver(): ProjectIdentityResolver {
  return {
    resolve: vi.fn(async (cwd: string) => ({
      identity: { kind: "path" as const, key: cwd, displayName: "project" },
      resolverRevision: "project-identity-v2",
      inputSignature: "test",
    })),
    shutdown: vi.fn(async () => {}),
  };
}

function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// --- Tests ---

afterEach(() => {
  coreMocks.attachProjectMetrics.mockClear();
  coreMocks.buildSessionTree.mockClear();
  coreMocks.buildDashboard.mockClear();
  coreMocks.filterSessionSearchCandidates.mockClear();
  coreMocks.getAnalyticsRevision.mockReset();
  coreMocks.getAnalyticsRevision.mockReturnValue("0");
  coreMocks.listDashboardCostFacts.mockReset();
  coreMocks.listDashboardCostFacts.mockReturnValue(null);
  coreMocks.materializeSessionDetailResponse.mockReset();
  coreMocks.listFileActivity.mockReset();
  coreMocks.listFileActivity.mockReturnValue([]);
  coreMocks.matchesProjectIdentity.mockClear();
  coreMocks.listSessionAliases.mockReset();
  coreMocks.listSessionAliases.mockReturnValue([]);
  // Successful alias reads are cached for the process lifetime; tests stub
  // listSessionAliases per case and need a fresh load each time.
  invalidateAliasView();
  coreMocks.executeSessionSearch.mockReset();
  coreMocks.executeSessionSearch.mockReturnValue([]);
  vi.useRealTimers();
});
export {
  coreMocks,
  makeAlias,
  makeMockContext,
  makeProjectIdentityResolver,
  makeScanResult,
  makeScanSource,
  makeSession,
  toLocalDateKey,
};

export type { DashboardCostFacts, ScanResultSource, SessionDetail, SessionHead };
