import { describe, expect, it } from "vitest";
import {
  formatSessionReference,
  getSessionReferenceKey,
  normalizeSessionReference,
  parseSessionReference,
  sessionRoutePath,
} from "../session-reference.js";

it("keeps remote identities distinct while preserving local links", () => {
  const local = { agentName: "codex", sessionId: "same/path" };
  const remote = { ...local, sourceNodeId: "worker-a" };
  expect(getSessionReferenceKey(remote)).not.toBe(getSessionReferenceKey(local));
  expect(parseSessionReference(formatSessionReference(remote))).toEqual(remote);
  expect(sessionRoutePath(remote)).toBe("/nodes/worker-a/codex/same%2Fpath");
  expect(sessionRoutePath({ ...local, sourceNodeId: "local" })).toBe(sessionRoutePath(local));
});

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
});
