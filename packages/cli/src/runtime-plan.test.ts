import { describe, expect, it } from "vitest";
import {
  buildCliRuntimePlan,
  parseSessionUri,
  redactStartupUrl,
  resolveStartupUrl,
  type TargetSession,
} from "./runtime-plan.js";

const NOW = new Date("2026-07-17T08:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const ENVIRONMENT = {
  currentWorkingDirectory: "/workspace/project",
  now: NOW,
};

describe("CLI runtime plan", () => {
  it("builds the default rolling scan plan", () => {
    expect(
      buildCliRuntimePlan(
        {
          days: "7",
          jsonOnly: false,
          targetSession: null,
          useCache: true,
        },
        ENVIRONMENT,
      ),
    ).toEqual({
      listWindow: { from: NOW - 7 * DAY_MS, to: undefined, days: 7 },
      scanOptions: { agents: undefined, cwd: undefined, useCache: true },
      startupScanOptions: { from: NOW - 7 * DAY_MS, to: undefined },
    });
  });

  it("normalizes agent filters and the current directory", () => {
    const plan = buildCliRuntimePlan(
      {
        agent: "claudecode, codex",
        cwd: ".",
        jsonOnly: false,
        targetSession: null,
        useCache: false,
      },
      ENVIRONMENT,
    );

    expect(plan.scanOptions).toEqual({
      agents: ["claudecode", "codex"],
      cwd: "/workspace/project",
      useCache: false,
    });
  });

  it("scans only the direct session agent without limiting startup discovery", () => {
    const targetSession = parseSessionUri("Codex://session-123");
    const plan = buildCliRuntimePlan(
      {
        agent: "claudecode",
        days: "7",
        jsonOnly: false,
        targetSession,
        useCache: true,
      },
      ENVIRONMENT,
    );

    expect(targetSession).toEqual({ agent: "Codex", sessionId: "session-123" });
    expect(plan.scanOptions.agents).toEqual(["Codex"]);
    expect(plan.startupScanOptions).toEqual({});
  });

  it("keeps JSON output windowing out of startup discovery", () => {
    const plan = buildCliRuntimePlan(
      {
        from: "2026-07-01",
        to: "2026-07-10",
        jsonOnly: true,
        targetSession: null,
        useCache: true,
      },
      ENVIRONMENT,
    );

    expect(plan.listWindow).toEqual({
      from: new Date("2026-07-01").getTime(),
      to: new Date("2026-07-10").getTime(),
    });
    expect(plan.startupScanOptions).toEqual({});
  });

  it.each(["codex/session-123", "codex://", "://session-123"])(
    "rejects invalid session URI %s",
    (uri) => {
      expect(parseSessionUri(uri)).toBeNull();
    },
  );

  it("resolves direct session browser routes", () => {
    const targetSession: TargetSession = { agent: "Codex", sessionId: "session-123" };

    expect(resolveStartupUrl("http://0.0.0.0:8080/?access_token=secret", targetSession)).toBe(
      "http://0.0.0.0:8080/codex/session-123?access_token=secret",
    );
    expect(resolveStartupUrl("http://127.0.0.1:4521/", null)).toBe("http://127.0.0.1:4521/");
  });

  it("redacts every startup URL query value", () => {
    const redacted = new URL(
      redactStartupUrl("http://0.0.0.0:4521/?access_token=secret&mode=remote"),
    );

    expect(Object.fromEntries(redacted.searchParams)).toEqual({
      access_token: "[redacted]",
      mode: "[redacted]",
    });
  });
});
