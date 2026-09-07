import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "codesesh-active-hours-"));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home,
}));

import { listDashboardActiveHours } from "../active-hours.js";
import { closeCacheStorage, getCachePath } from "../db.js";
import { syncSessionSearchIndex } from "../search.js";
import { saveCachedSessions } from "../sessions.js";
import { loadCachedSessionRawEntry } from "../sessions.js";
import { makeSessionHead } from "./fixtures.js";
import type { Message } from "../../../types/index.js";

const from = Date.parse("2026-09-06T00:00:00Z");
const to = Date.parse("2026-09-07T23:59:59.999Z");
const options = { from, to, timeZone: "UTC" };
function message(id: string, time: number, extra: Partial<Message> = {}): Message {
  return { id, role: "user", time_created: time, parts: [{ type: "text", text: id }], ...extra };
}

function seed() {
  const parent = makeSessionHead("parent", { time_updated: to + 86400000 });
  const child = makeSessionHead("child", { parent_reference: parent.reference });
  const orphan = makeSessionHead("orphan", {
    parent_reference: { agentName: "codex", sessionId: "missing" },
  });
  const other = makeSessionHead("other", {
    project_identity: { kind: "path", key: "/other", displayName: "other" },
  });
  const sessions = [parent, child, orphan, other];
  const contents: Record<string, Message[]> = {
    parent: [
      message("before", from - 1),
      message("midnight", from),
      message("before-two", from + 7200000 - 1),
      message("two", from + 7200000),
      message("next-day", from + 86400000),
      message("end", to),
      message("after", to + 1),
      message("untimed", 0),
      message("assistant", from, { role: "assistant" }),
      message("tool", from, { role: "tool" }),
      message("injected", from, { automated: true }),
    ],
    child: [message("delegated", from)],
    orphan: [message("orphan-delegated", from)],
    other: [message("other-project", from)],
  };
  saveCachedSessions("codex", sessions);
  syncSessionSearchIndex("codex", sessions, (id) => ({
    ...sessions.find((s) => s.reference.sessionId === id)!,
    messages: contents[id]!,
  }));
}

afterEach(() => {
  closeCacheStorage();
  rmSync(home, { recursive: true, force: true });
});

describe("user active hours", () => {
  it("counts human messages by send time with scope and interval boundaries", () => {
    seed();
    const result = listDashboardActiveHours(options)!;
    expect(result.counts).toHaveLength(84);
    expect(result.counts.reduce((a, b) => a + b)).toBe(6);
    expect(result.counts[0]).toBe(3);
    expect(result.counts[1]).toBe(1);
    expect(result.counts[12]).toBe(1);
    expect(result.counts[23]).toBe(1);
    const project = listDashboardActiveHours({
      ...options,
      projectKind: "path",
      projectKey: "/workspace/project",
    })!;
    expect(project.counts.reduce((a, b) => a + b)).toBe(5);
    expect(
      listDashboardActiveHours(options, { agents: ["pi"] })!.counts.every((n) => n === 0),
    ).toBe(true);
    expect(
      listDashboardActiveHours({ ...options, agent: "pi" })!.counts.every((n) => n === 0),
    ).toBe(true);
    expect(
      loadCachedSessionRawEntry("codex", "parent")?.messageRows.find(
        (m) => m.message_id === "injected",
      )?.automated,
    ).toBe(1);
  });

  it.each([undefined, from])("reads the user activity index with lower bound %s", (lowerBound) => {
    seed();
    const prepare = vi.spyOn(Database.prototype, "prepare");
    let sql: string;
    try {
      expect(listDashboardActiveHours({ ...options, from: lowerBound })!.counts).toHaveLength(84);
      sql = prepare.mock.calls.find(([source]) => source.includes("SELECT m.time_created"))![0];
    } finally {
      prepare.mockRestore();
    }
    const db = new Database(getCachePath(), { readonly: true });
    try {
      const params = lowerBound === undefined ? [to] : [to, lowerBound];
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
      expect(plan[0]!.detail).toContain("idx_messages_user_activity");
      expect(plan.map(({ detail }) => detail).join("\n")).not.toContain("idx_messages_session");
    } finally {
      db.close();
    }
  });

  it("uses the requested time zone across midnight and repeated DST hours", () => {
    const session = makeSessionHead("dst");
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => ({
      ...session,
      messages: [
        message("first", Date.parse("2026-11-01T05:30:00Z")),
        message("second", Date.parse("2026-11-01T06:30:00Z")),
      ],
    }));
    const window = {
      from: Date.parse("2026-11-01T00:00:00Z"),
      to: Date.parse("2026-11-02T00:00:00Z"),
    };
    expect(listDashboardActiveHours({ ...window, timeZone: "America/New_York" })!.counts[0]).toBe(
      2,
    );
    expect(listDashboardActiveHours({ ...window, timeZone: "Asia/Tokyo" })!.counts[7]).toBe(2);
    expect(
      listDashboardActiveHours({ ...window, timeZone: "Pacific/Honolulu" })!.counts[6 * 12 + 9],
    ).toBe(1);
  });

  it("distinguishes unavailable storage from an empty activity window", () => {
    expect(listDashboardActiveHours(options)).toBeNull();
    seed();
    expect(listDashboardActiveHours({ ...options, from: to, to })!.counts[23]).toBe(1);
  });
});
