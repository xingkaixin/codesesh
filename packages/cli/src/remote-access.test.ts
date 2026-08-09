import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRemoteAccessToken,
  isConfidentialTransport,
  isLoopbackHostname,
  RemoteTransportError,
  resolveRemoteAccessPolicy,
  resolveRemoteTransport,
} from "./remote-access.js";

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

  it("resolves authentication from the complete exposure boundary", () => {
    expect(resolveRemoteAccessPolicy("127.0.0.1", { kind: "loopback" })).toEqual({
      bindCategory: "loopback",
      authenticationRequired: false,
    });
    expect(resolveRemoteAccessPolicy("127.0.0.1", { kind: "trusted-proxy" })).toEqual({
      bindCategory: "loopback",
      authenticationRequired: true,
    });
    expect(resolveRemoteAccessPolicy("0.0.0.0", { kind: "plaintext" })).toEqual({
      bindCategory: "network",
      authenticationRequired: true,
    });
  });
});

describe("CS-140: remote transport", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeKeyPair() {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-tls-"));
    tempDirs.push(dir);
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, "certificate");
    writeFileSync(keyPath, "private key");
    return { certPath, keyPath };
  }

  it("treats a loopback host as protected without configuration", () => {
    expect(resolveRemoteTransport({ hostname: "127.0.0.1" })).toEqual({ kind: "loopback" });
    expect(isConfidentialTransport({ kind: "loopback" })).toBe(true);
  });

  it("reports a plaintext non-loopback listener as unprotected", () => {
    const transport = resolveRemoteTransport({ hostname: "0.0.0.0" });

    expect(transport).toEqual({ kind: "plaintext" });
    expect(isConfidentialTransport(transport)).toBe(false);
  });

  it("loads a certificate and key for direct TLS", () => {
    const { certPath, keyPath } = writeKeyPair();

    const transport = resolveRemoteTransport({
      hostname: "0.0.0.0",
      tlsCertPath: certPath,
      tlsKeyPath: keyPath,
    });

    expect(transport.kind).toBe("tls");
    expect(isConfidentialTransport(transport)).toBe(true);
  });

  it.each([
    ["only a certificate", { tlsCertPath: "cert.pem" }],
    ["only a key", { tlsKeyPath: "key.pem" }],
  ])("rejects %s", (_name, partial) => {
    expect(() => resolveRemoteTransport({ hostname: "0.0.0.0", ...partial })).toThrow(
      RemoteTransportError,
    );
  });

  it("rejects TLS and a trusted proxy together", () => {
    const { certPath, keyPath } = writeKeyPair();

    expect(() =>
      resolveRemoteTransport({
        hostname: "0.0.0.0",
        tlsCertPath: certPath,
        tlsKeyPath: keyPath,
        trustProxy: true,
      }),
    ).toThrow(RemoteTransportError);
  });

  it("reports an unreadable certificate instead of starting", () => {
    expect(() =>
      resolveRemoteTransport({
        hostname: "0.0.0.0",
        tlsCertPath: join(tmpdir(), "codesesh-missing-cert.pem"),
        tlsKeyPath: join(tmpdir(), "codesesh-missing-key.pem"),
      }),
    ).toThrow(RemoteTransportError);
  });

  it("accepts a trusted proxy as protected", () => {
    const transport = resolveRemoteTransport({ hostname: "0.0.0.0", trustProxy: true });

    expect(transport).toEqual({ kind: "trusted-proxy" });
    expect(isConfidentialTransport(transport)).toBe(true);
  });
});
