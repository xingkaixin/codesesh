import { describe, expect, it } from "vitest";
import type { IdentifiedSessionHead } from "../session.js";
import {
  isSmartTag,
  SMART_TAGS,
  toPublicReferencedSessionHead,
  toPublicSessionHead,
} from "../session.js";

const session: IdentifiedSessionHead = {
  reference: { agentName: "codex", sessionId: "session" },
  title: "Session",
  directory: "/workspace",
  project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
  project_identity_resolver_revision: "resolver-v2",
  project_identity_input_signature: "signature",
  time_created: 1,
  stats: {
    message_count: 1,
    total_input_tokens: 2,
    total_output_tokens: 3,
    total_cost: 0,
  },
  model_usage: { "gpt-5.5": 5 },
  smart_tags: ["testing"],
  smart_tags_source_updated_at: 2,
  smart_tags_classifier_revision: "classifier-v2",
};

describe("public session heads", () => {
  it("removes internal metadata without mutating the source", () => {
    const result = toPublicSessionHead(session);

    expect(result).toEqual({
      reference: session.reference,
      title: "Session",
      directory: "/workspace",
      project_identity: session.project_identity,
      time_created: 1,
      stats: session.stats,
      smart_tags: ["testing"],
    });
    expect(session.model_usage).toEqual({ "gpt-5.5": 5 });
  });

  it("preserves surrounding transport fields", () => {
    expect(
      toPublicReferencedSessionHead({
        reference: session.reference,
        session,
        snippet: "match",
      }),
    ).toEqual({
      reference: session.reference,
      session: toPublicSessionHead(session),
      snippet: "match",
    });
  });
});

describe("smart tags", () => {
  it("derives runtime validation and ordering from the public catalog", () => {
    expect(SMART_TAGS.every(isSmartTag)).toBe(true);
    expect(isSmartTag("BUGFIX")).toBe(false);
    expect(isSmartTag("unknown")).toBe(false);
  });
});
