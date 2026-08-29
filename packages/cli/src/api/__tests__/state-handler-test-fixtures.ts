import { afterEach, beforeEach, vi, type Mock } from "vitest";

type StateMockName =
  | "deleteBookmark"
  | "deleteSessionAlias"
  | "importBookmarks"
  | "listBookmarks"
  | "listDashboardCostFacts"
  | "listFileActivity"
  | "listSessionAliases"
  | "upsertBookmark"
  | "upsertSessionAlias";

const coreMocks: Record<StateMockName, Mock> = vi.hoisted(() => ({
  deleteBookmark: vi.fn(),
  deleteSessionAlias: vi.fn(),
  importBookmarks: vi.fn(),
  listBookmarks: vi.fn(),
  listDashboardCostFacts: vi.fn(() => null),
  listFileActivity: vi.fn(),
  listSessionAliases: vi.fn(),
  upsertBookmark: vi.fn(),
  upsertSessionAlias: vi.fn(),
}));

type LoggerMockName = "debug" | "error" | "info" | "warn";

const loggerMocks: Record<LoggerMockName, Mock> = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@codesesh/core/runtime/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime/state")>();
  return {
    ...actual,
    deleteBookmark: coreMocks.deleteBookmark,
    deleteSessionAlias: coreMocks.deleteSessionAlias,
    importBookmarks: coreMocks.importBookmarks,
    listBookmarks: coreMocks.listBookmarks,
    listSessionAliases: coreMocks.listSessionAliases,
    upsertBookmark: coreMocks.upsertBookmark,
    upsertSessionAlias: coreMocks.upsertSessionAlias,
  };
});

vi.mock("@codesesh/core/runtime/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codesesh/core/runtime/discovery")>()),
  listDashboardCostFacts: coreMocks.listDashboardCostFacts,
  listFileActivity: coreMocks.listFileActivity,
}));

vi.mock("../../logging.js", () => ({ appLogger: loggerMocks }));
import type { BookmarkRecord, BookmarkView } from "@codesesh/core/runtime/state";
import type { LiveSnapshot, SessionHead } from "@codesesh/core/runtime/discovery";
import type { ScanResultSource } from "../scan-sources.js";
import { invalidateAliasView } from "../session-aliases-view.js";
import type { ProjectIdentityResolver } from "../../project-identity-resolver.js";

interface ContextOptions {
  body?: unknown;
  rejectBody?: boolean;
  param?: Record<string, string>;
  query?: Record<string, string>;
}

interface TestContext {
  req: {
    json: () => Promise<unknown>;
    param: (key: string) => string | undefined;
    query: (key: string) => string | undefined;
    url: string;
    raw: Request;
  };
  json: Mock<
    (
      payload: unknown,
      status?: number,
    ) => {
      payload: unknown;
      status: number;
    }
  >;
}

function makeContext(options: ContextOptions = {}): TestContext {
  const params = new URLSearchParams(options.query ?? {});
  const url = `http://localhost/${params.size > 0 ? `?${params.toString()}` : ""}`;
  return {
    req: {
      json: () =>
        options.rejectBody
          ? Promise.reject(new SyntaxError("invalid JSON"))
          : Promise.resolve(options.body),
      param: (key: string) => options.param?.[key],
      query: (key: string) => options.query?.[key],
      url,
      raw: new Request(url),
    },
    json: vi.fn((payload: unknown, status = 200) => ({ payload, status })),
  };
}

function makeProjectIdentityResolver(): ProjectIdentityResolver {
  return {
    resolve: vi.fn(async (cwd: string) => ({
      identity: { kind: "path" as const, key: cwd, displayName: "repo" },
      resolverRevision: "project-identity-v2",
      inputSignature: "test",
    })),
    shutdown: vi.fn(async () => {}),
  };
}

function getResponsePayload<T>(context: ReturnType<typeof makeContext>): T {
  return context.json.mock.calls[0]![0] as T;
}

const validReference = { agentName: "codex", sessionId: "s1" };

const sessionHead: SessionHead = {
  reference: validReference,
  title: "Session one",
  directory: "/workspace",
  time_created: 1,
  time_updated: 2,
  stats: {
    message_count: 1,
    total_input_tokens: 2,
    total_output_tokens: 3,
    total_cost: 0.1,
    total_tokens: 5,
  },
};

const legacyBookmark = {
  agentKey: "codex",
  sessionId: "s1",
  fullPath: "stale/legacy-route",
  title: "Session one",
  directory: "/workspace",
  time_created: 1,
  time_updated: 2,
  bookmarked_at: 3,
  stats: {
    message_count: 1,
    total_input_tokens: 2,
    total_output_tokens: 3,
    total_cost: 0.1,
    total_tokens: 5,
  },
};

const storedBookmark: BookmarkRecord = {
  reference: validReference,
  bookmarkedAt: 3,
};

const availableBookmark: BookmarkView = {
  ...storedBookmark,
  availability: "available",
  session: sessionHead,
};

const scanSource: ScanResultSource = {
  getSnapshot: () =>
    ({
      sessions: [],
      byAgent: { codex: [] },
      agents: [],
    }) as LiveSnapshot,
};

const bookmarkScanSource: ScanResultSource = {
  getSnapshot: () =>
    ({
      sessions: [sessionHead],
      byAgent: { codex: [sessionHead] },
      agents: [],
    }) as LiveSnapshot,
};

beforeEach(() => {
  vi.resetAllMocks();
  // Successful alias reads are cached for the process lifetime; each test needs
  // a clean slate or it inherits the previous test's listSessionAliases stub.
  invalidateAliasView();
  coreMocks.listBookmarks.mockReturnValue([]);
  coreMocks.listFileActivity.mockReturnValue([]);
  coreMocks.listSessionAliases.mockReturnValue([]);
  coreMocks.upsertBookmark.mockReturnValue(storedBookmark);
  coreMocks.importBookmarks.mockReturnValue([storedBookmark]);
  coreMocks.upsertSessionAlias.mockReturnValue({
    reference: { agentName: "codex", sessionId: "s1" },
    alias: "Renamed",
    updatedAt: 1,
  });
});

afterEach(() => vi.useRealTimers());

export {
  availableBookmark,
  bookmarkScanSource,
  coreMocks,
  getResponsePayload,
  legacyBookmark,
  loggerMocks,
  makeContext,
  makeProjectIdentityResolver,
  scanSource,
  sessionHead,
  storedBookmark,
  validReference,
};

export type { BookmarkView, LiveSnapshot, ScanResultSource };
