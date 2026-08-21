import { describe, expect, it } from "vitest";
import * as core from "../index.js";

describe("core public interface", () => {
  it("exposes only the high-level scan operation at the package root", () => {
    expect(Object.keys(core)).toEqual(["scanSessions"]);
  });
});
