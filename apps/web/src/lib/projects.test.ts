import { describe, expect, it } from "vitest";
import { getProjectPath, type ProjectRouteIdentity } from "./projects";

function getRouteKey(project: ProjectRouteIdentity): string {
  const segments = getProjectPath(project)
    .replace(/^\/+|\/+$/g, "")
    .split("/");

  return decodeURIComponent(segments[2]!);
}

describe("project routes", () => {
  it("round-trips reserved characters in project keys", () => {
    const project = {
      kind: "path",
      key: "/tmp/100% done",
    } satisfies ProjectRouteIdentity;

    expect(getProjectPath(project)).toBe("/projects/path/%2Ftmp%2F100%25%20done");
    expect(getRouteKey(project)).toBe(project.key);
  });
});
