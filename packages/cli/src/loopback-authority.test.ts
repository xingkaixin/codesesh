import { describe, expect, it } from "vitest";
import { validateLoopbackAuthority } from "./loopback-authority.js";

function host(value: string): string[] {
  return ["Host", value];
}

describe("validateLoopbackAuthority", () => {
  it.each(["localhost:4521", "LOCALHOST:4521", "127.0.0.1:4521", "[::1]:4521"])(
    "accepts the canonical loopback authority %s",
    (authority) => {
      expect(validateLoopbackAuthority(host(authority), "127.0.0.1", 4521)).toMatchObject({
        allowed: true,
      });
    },
  );

  it("accepts an explicitly configured loopback listener hostname", () => {
    expect(validateLoopbackAuthority(host("127.20.30.40:4521"), "127.20.30.40", 4521)).toEqual({
      allowed: true,
      authority: "127.20.30.40:4521",
    });
  });

  it.each([
    ["not ready", host("localhost:4521"), null, "listener-not-ready"],
    ["missing", [], 4521, "missing-host"],
    ["duplicate", ["Host", "localhost:4521", "host", "127.0.0.1:4521"], 4521, "multiple-hosts"],
    ["userinfo", host("attacker@localhost:4521"), 4521, "invalid-host"],
    ["unbracketed IPv6", host("::1:4521"), 4521, "invalid-host"],
    ["missing port", host("localhost"), 4521, "invalid-host"],
    ["wrong port", host("localhost:4522"), 4521, "port-mismatch"],
    ["attacker domain", host("attacker.example:4521"), 4521, "hostname-not-allowed"],
    ["different loopback IP", host("127.0.0.2:4521"), 4521, "hostname-not-allowed"],
  ])("rejects a %s authority", (_name, rawHeaders, port, reason) => {
    expect(
      validateLoopbackAuthority(rawHeaders as string[], "127.0.0.1", port as number | null),
    ).toMatchObject({
      allowed: false,
      reason,
    });
  });
});
