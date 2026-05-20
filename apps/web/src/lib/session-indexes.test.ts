import { describe, expect, it } from "vitest";
import type { AgentInfo, SessionHead } from "./api";
import {
  buildSessionIndexes,
  buildSidebarSessionLookup,
  getProjectAgentKey,
  getSessionRouteKey,
} from "./session-indexes";

const agents: AgentInfo[] = [
  { name: "codex", displayName: "Codex", count: 3, icon: "/codex.svg" },
  { name: "claude", displayName: "Claude", count: 1, icon: "/claude.svg" },
];

function createSession(
  overrides: Partial<SessionHead> & Pick<SessionHead, "id" | "slug" | "title">,
): SessionHead {
  return {
    id: overrides.id,
    slug: overrides.slug,
    title: overrides.title,
    directory: overrides.directory ?? "/workspace/a",
    project_identity: overrides.project_identity,
    time_created: overrides.time_created ?? 1,
    time_updated: overrides.time_updated,
    stats: overrides.stats ?? {
      message_count: 1,
      total_input_tokens: 2,
      total_output_tokens: 3,
      total_cost: 0,
    },
    smart_tags: overrides.smart_tags,
  };
}

describe("session indexes", () => {
  it("indexes sessions once by route, agent, project, and activity order", () => {
    const projectA = { kind: "path" as const, key: "/workspace/a", displayName: "Project A" };
    const projectB = { kind: "path" as const, key: "/workspace/b", displayName: "Project B" };
    const oldCodex = createSession({
      id: "old",
      slug: "codex/old",
      title: "Old",
      project_identity: projectA,
      time_updated: 100,
    });
    const claude = createSession({
      id: "claude",
      slug: "claude/claude",
      title: "Claude",
      project_identity: projectA,
      time_updated: 200,
    });
    const newCodex = createSession({
      id: "new",
      slug: "codex/new",
      title: "New",
      project_identity: projectA,
      time_updated: 300,
    });
    const otherCodex = createSession({
      id: "other",
      slug: "codex/other",
      title: "Other",
      directory: "/workspace/b",
      project_identity: projectB,
      time_updated: 400,
    });

    const indexes = buildSessionIndexes([oldCodex, claude, newCodex, otherCodex], agents);

    expect(indexes.byRouteKey.get(getSessionRouteKey("CoDeX", "old"))).toBe(oldCodex);
    expect(indexes.byAgent.get("codex")?.map((session) => session.id)).toEqual([
      "other",
      "new",
      "old",
    ]);
    expect(
      indexes.byProjectIdentityKey.get("path:/workspace/a")?.map((session) => session.id),
    ).toEqual(["new", "claude", "old"]);
    expect(
      indexes.byProjectAgentKey
        .get(getProjectAgentKey("path:/workspace/a", "codex"))
        ?.map((session) => session.id),
    ).toEqual(["new", "old"]);
    expect(indexes.byProjectKey.get("/workspace/a")?.map((session) => session.id)).toEqual([
      "new",
      "claude",
      "old",
    ]);
    expect(indexes.sessionsByActivity.map((session) => session.id)).toEqual([
      "other",
      "new",
      "claude",
      "old",
    ]);
    expect(indexes.landingSessions.map((session) => session.id)).toEqual([
      "old",
      "claude",
      "new",
      "other",
    ]);
    expect(indexes.byLandingAgent.get("codex")?.map((session) => session.id)).toEqual([
      "old",
      "new",
      "other",
    ]);
    expect(indexes.projectOptions).toEqual([
      { key: "/workspace/a", label: "Project A", count: 3 },
      { key: "/workspace/b", label: "Project B", count: 1 },
    ]);
  });

  it("keeps sidebar lookup compatible with first-match selection", () => {
    const first = createSession({ id: "same", slug: "codex/same", title: "First" });
    const duplicate = createSession({ id: "same", slug: "claude/same", title: "Duplicate" });
    const next = createSession({ id: "next", slug: "codex/next", title: "Next" });

    const lookup = buildSidebarSessionLookup([first, duplicate, next]);

    expect(lookup.byId.get("same")).toBe(first);
    expect(lookup.indexById.get("same")).toBe(0);
    expect(lookup.byId.get("next")).toBe(next);
    expect(lookup.indexById.get("next")).toBe(2);
  });

  it("keeps route lookup compatible with first-match session search", () => {
    const first = createSession({ id: "same", slug: "codex/same", title: "First" });
    const duplicate = createSession({ id: "same", slug: "codex/same", title: "Duplicate" });

    const indexes = buildSessionIndexes([first, duplicate], agents);

    expect(indexes.byRouteKey.get(getSessionRouteKey("codex", "same"))).toBe(first);
  });
});
