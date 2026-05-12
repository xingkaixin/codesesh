import { describe, expect, it } from "vitest";
import { decodeProjectRouteKey, getProjectPath, type ProjectRouteIdentity } from "./projects";

function getRouteKey(project: ProjectRouteIdentity): string {
  const segments = getProjectPath(project)
    .replace(/^\/+|\/+$/g, "")
    .split("/");

  return decodeProjectRouteKey(segments[2]!);
}

describe("project routes", () => {
  it("round-trips absolute path project keys", () => {
    const project = {
      kind: "path",
      key: "/Users/Kevin/Dropbox/OBSIDIAN/XingKaiXin/90.Clippings",
    } satisfies ProjectRouteIdentity;

    expect(getProjectPath(project)).toBe(
      "/projects/path/%2FUsers%2FKevin%2FDropbox%2FOBSIDIAN%2FXingKaiXin%2F90.Clippings",
    );
    expect(getRouteKey(project)).toBe(project.key);
  });

  it("round-trips reserved characters in project keys", () => {
    const project = {
      kind: "path",
      key: "/tmp/100% done",
    } satisfies ProjectRouteIdentity;

    expect(getProjectPath(project)).toBe("/projects/path/%2Ftmp%2F100%25%20done");
    expect(getRouteKey(project)).toBe(project.key);
  });
});
