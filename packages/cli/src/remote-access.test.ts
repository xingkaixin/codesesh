import { describe, expect, it } from "vitest";
import { createRemoteAccessToken, isLoopbackHostname } from "./remote-access.js";

describe("remote access", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.20.30.40", "::1", "[::1]"])(
    "recognizes %s as loopback",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    },
  );

  it.each(["0.0.0.0", "192.168.1.10", "::", "codesesh.local"])(
    "recognizes %s as non-loopback",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );

  it("creates a fresh 256-bit URL-safe token", () => {
    const first = createRemoteAccessToken();
    const second = createRemoteAccessToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });
});
