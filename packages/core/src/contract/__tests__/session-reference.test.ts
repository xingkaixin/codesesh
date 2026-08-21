import { describe, expect, it } from "vitest";
import {
  agentRoutePath,
  assertSessionIdentity,
  createSessionIdentity,
  formatSessionReference,
  getSessionAgentKey,
  getSessionReferenceKey,
  getSessionRoutePath,
  normalizeSessionReference,
  parseSessionReference,
  sessionRoutePath,
} from "../session-reference.js";

/** Ids whose characters carry URL meaning, so a raw path would split or truncate. */
const OPAQUE_IDS = [
  "plain-session",
  "nested/session",
  "query?part",
  "fragment#part",
  "percent%part",
  "plus+and&amp",
  "空格 和 unicode ✓",
];

describe("session references", () => {
  it("normalizes the agent name and preserves the opaque session ID", () => {
    const reference = parseSessionReference("CoDeX/nested/session");

    expect(reference).toEqual({
      agentName: "codex",
      sessionId: "nested/session",
    });
    expect(formatSessionReference({ ...reference!, agentName: " CoDeX " })).toBe(
      "codex/nested/session",
    );
    expect(
      normalizeSessionReference({ agentName: " CoDeX ", sessionId: "nested/session" }),
    ).toEqual(reference);
    expect(getSessionReferenceKey({ agentName: " CoDeX ", sessionId: "nested/session" })).toBe(
      "codex/nested/session",
    );
  });

  it.each(["", "codex", "/session", "codex/"])("rejects malformed value %j", (value) => {
    expect(parseSessionReference(value)).toBeNull();
  });

  it("derives compatibility fields from one canonical reference", () => {
    const identity = createSessionIdentity({ agentName: " CoDeX ", sessionId: "nested/session" });

    expect(identity).toEqual({
      reference: { agentName: "codex", sessionId: "nested/session" },
      id: "nested/session",
      slug: "codex/nested/session",
    });
    expect(getSessionAgentKey(identity)).toBe("codex");
    expect(() => assertSessionIdentity({ ...identity, id: "different" }, "codex")).toThrow(
      "Session identity fields disagree",
    );
  });
});

describe("session reference transport", () => {
  it.each(OPAQUE_IDS)("CS-132: round-trips %j through a route path", (sessionId) => {
    const path = sessionRoutePath({ agentName: "CoDeX", sessionId });
    const [, agentSegment, ...rest] = path.split("/");

    expect(rest).toHaveLength(1);
    expect(decodeURIComponent(agentSegment!)).toBe("codex");
    expect(decodeURIComponent(rest[0]!)).toBe(sessionId);
  });

  it("CS-132: leaves an ordinary id readable", () => {
    expect(sessionRoutePath({ agentName: "codex", sessionId: "abc-123" })).toBe("/codex/abc-123");
    expect(agentRoutePath(" CoDeX ")).toBe("/codex");
  });

  it("CS-132: derives the same path from a session head", () => {
    const session = createSessionIdentity({
      agentName: "codex",
      sessionId: "nested/session",
    });

    expect(getSessionRoutePath(session)).toBe(
      sessionRoutePath({ agentName: "codex", sessionId: "nested/session" }),
    );
  });
});
