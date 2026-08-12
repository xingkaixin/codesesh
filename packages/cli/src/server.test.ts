import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer as createNodeServer, type Server as NodeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/core/contract";
import { appLogger } from "./logging.js";
import { createServer } from "./server.js";
import { resolveRemoteTransport } from "./remote-access.js";

const serveOptionsLog = vi.hoisted(
  () => [] as { hostname?: string; port?: number; hasCreateServer: boolean }[],
);

function httpRequest(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string | undefined }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpGet(url, { headers, agent: false }, (response) => {
      resolvePromise({
        status: response.statusCode ?? 0,
        contentType: response.headers["content-type"],
      });
      response.destroy();
      request.destroy();
    });
    request.on("error", reject);
  });
}

vi.mock("@hono/node-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hono/node-server")>();
  return {
    ...actual,
    serve: (options: Parameters<typeof actual.serve>[0]) => {
      serveOptionsLog.push({
        hostname: (options as { hostname?: string }).hostname,
        port: (options as { port?: number }).port,
        hasCreateServer: "createServer" in (options as object),
      });
      return actual.serve(options);
    },
  };
});

/** Requests a self-signed listener; Node's fetch has no per-call trust override. */
function httpsRequest(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string | undefined }> {
  return new Promise((resolvePromise, reject) => {
    // agent:false so no keep-alive socket outlives the request and stalls close().
    const request = httpsGet(
      url,
      { headers, rejectUnauthorized: false, agent: false },
      (response) => {
        resolvePromise({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"],
        });
        // The SSE route never ends on its own, so drop the socket rather than
        // waiting for a body.
        response.destroy();
        request.destroy();
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") return;
      reject(error);
    });
  });
}

/** Self-signed material for the TLS listener; requires openssl on PATH. */
function createTestCertificate(): { certPath: string; keyPath: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-tls-server-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    return { certPath, keyPath };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

function createStore() {
  return {
    getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }),
    getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
    subscribe: () => () => {},
    subscribeScanStatus: () => () => {},
    shutdown: vi.fn(),
  };
}

function createLargeSessionsStore() {
  const sessions = Array.from({ length: 200 }, (_, index) => ({
    id: `session-${index}`,
    slug: `codex/session-${index}`,
    title: `Session with a reasonably descriptive title ${index}`,
    directory: "/repo/some/nested/project/directory",
    time_created: index,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  }));
  return {
    getSnapshot: () => ({ sessions, byAgent: { codex: sessions }, agents: [] }),
    getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
    subscribe: () => () => {},
    subscribeScanStatus: () => () => {},
    shutdown: vi.fn(),
  };
}

async function listen(server: NodeServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

async function close(server: NodeServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createBlockedPortWithFreeNext(): Promise<{ blocker: NodeServer; port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const blocker = createNodeServer();
    const port = await listen(blocker, 0);
    const nextProbe = createNodeServer();

    try {
      await listen(nextProbe, port + 1);
      await close(nextProbe);
      return { blocker, port };
    } catch {
      await close(blocker);
    }
  }

  throw new Error("Unable to find consecutive free ports");
}

describe("createServer", () => {
  it("reports the actual port when binding to port 0", async () => {
    const app = await createServer(0, createStore());

    expect(app.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(app.url).not.toBe("http://localhost:0");

    await app.shutdown();
  });

  it("falls back to the next port when enabled", async () => {
    const { blocker, port } = await createBlockedPortWithFreeNext();
    let app: Awaited<ReturnType<typeof createServer>> | null = null;

    try {
      app = await createServer(port, createStore(), { portFallbackAttempts: 2 });

      expect(app.url).toBe(`http://localhost:${port + 1}`);
    } finally {
      await app?.shutdown();
      await close(blocker);
    }
  });

  it("binds to 127.0.0.1 by default", async () => {
    const app = await createServer(0, createStore());

    expect(serveOptionsLog.at(-1)?.hostname).toBe("127.0.0.1");
    expect(app.url).toMatch(/^http:\/\/localhost:\d+$/);

    await app.shutdown();
  });

  it("CS-160: enforces loopback authority before API, SSE, and static routes", async () => {
    const webDist = mkdtempSync(join(tmpdir(), "codesesh-authority-web-"));
    writeFileSync(join(webDist, "index.html"), "<html>app shell</html>");
    writeFileSync(join(webDist, "app.js"), "console.log('bundle')");
    const app = await createServer(0, createStore(), { webDistPath: webDist });
    const port = new URL(app.url).port;

    try {
      for (const authority of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
        expect((await httpRequest(`${app.url}/api/agents`, { Host: authority })).status).toBe(200);
      }
      expect(
        (
          await httpRequest(`${app.url}/api/agents`, {
            Host: `localhost:${port}`,
            Origin: "https://attacker.example",
          })
        ).status,
      ).toBe(200);

      for (const path of ["/api/agents", "/api/events", "/app.js"]) {
        expect(
          (
            await httpRequest(`${app.url}${path}`, {
              Host: `attacker.example:${port}`,
            })
          ).status,
        ).toBe(403);
      }
    } finally {
      await app.shutdown();
      rmSync(webDist, { recursive: true, force: true });
    }
  });

  it("CS-193: rejects unsafe loopback writes without breaking same-origin JSON", async () => {
    const app = await createServer(0, createStore());
    const body = JSON.stringify({ event: "csrf-probe" });

    try {
      const textPlain = await fetch(`${app.url}/api/logs`, {
        method: "POST",
        headers: { Connection: "close", "Content-Type": "text/plain", Origin: app.url },
        body,
      });
      const bookmarkImport = await fetch(`${app.url}/api/bookmarks/import`, {
        method: "POST",
        headers: { Connection: "close", "Content-Type": "text/plain", Origin: app.url },
        body: "[]",
      });
      const crossOrigin = await fetch(`${app.url}/api/logs`, {
        method: "POST",
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
        },
        body,
      });
      const crossSite = await fetch(`${app.url}/api/logs`, {
        method: "POST",
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
        body,
      });
      const sameOrigin = await fetch(`${app.url}/api/logs`, {
        method: "POST",
        headers: { Connection: "close", "Content-Type": "application/json", Origin: app.url },
        body,
      });
      const statuses = {
        textPlain: textPlain.status,
        bookmarkImport: bookmarkImport.status,
        crossOrigin: crossOrigin.status,
        crossSite: crossSite.status,
        sameOrigin: sameOrigin.status,
      };

      expect(statuses).toEqual({
        textPlain: 415,
        bookmarkImport: 415,
        crossOrigin: 403,
        crossSite: 403,
        sameOrigin: 200,
      });
    } finally {
      await app.shutdown();
    }
  });

  it("refuses a non-loopback hostname without remote access", async () => {
    await expect(createServer(0, createStore(), { hostname: "0.0.0.0" })).rejects.toThrow(
      "Add --remote-access",
    );
  });

  it("protects remote API requests with the generated access token", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const app = await createServer(0, createStore(), {
        hostname: "0.0.0.0",
        remoteAccess: true,
        remoteAccessToken: "test-access-token",
      });
      const startupUrl = new URL(app.url);
      const requestOrigin = `http://127.0.0.1:${startupUrl.port}`;

      expect(serveOptionsLog.at(-1)?.hostname).toBe("0.0.0.0");
      expect(startupUrl.searchParams.get("access_token")).toBe("test-access-token");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("远程访问已启用"));

      expect((await fetch(`${requestOrigin}/api/agents`)).status).toBe(401);
      expect(
        (
          await fetch(`${requestOrigin}/api/agents`, {
            headers: { Authorization: "Bearer test-access-token" },
          })
        ).status,
      ).toBe(200);
      expect(
        (await fetch(`${requestOrigin}/api/agents?access_token=test-access-token`)).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${requestOrigin}/api/logs?access_token=test-access-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "test" }),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${requestOrigin}/api/logs`, {
            method: "POST",
            headers: {
              Authorization: "Bearer test-access-token",
              "Content-Type": "application/json",
              "Sec-Fetch-Site": "cross-site",
            },
            body: JSON.stringify({ event: "cross-site-probe" }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${requestOrigin}/api/logs`, {
            method: "POST",
            headers: {
              Authorization: "Bearer test-access-token",
              "Content-Type": "application/json",
              Origin: requestOrigin,
            },
            body: JSON.stringify({ event: "same-origin-probe" }),
          })
        ).status,
      ).toBe(200);

      await app.shutdown();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects oversized authenticated request bodies", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await createServer(0, createStore(), {
      hostname: "0.0.0.0",
      remoteAccessToken: "test-access-token",
    });
    const startupUrl = new URL(app.url);
    const requestOrigin = `http://127.0.0.1:${startupUrl.port}`;

    try {
      const response = await fetch(`${requestOrigin}/api/logs`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-access-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event: "test", data: "x".repeat(1024 * 1024) }),
      });

      expect(response.status).toBe(413);
    } finally {
      await app.shutdown();
      warnSpy.mockRestore();
    }
  });

  it("compresses large JSON API responses but leaves the SSE stream untouched", async () => {
    const app = await createServer(0, createLargeSessionsStore());

    try {
      const sessionsResponse = await fetch(`${app.url}/api/sessions`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(sessionsResponse.headers.get("Content-Encoding")).toBe("gzip");

      const eventsResponse = await fetch(`${app.url}/api/events`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(eventsResponse.headers.get("Content-Encoding")).toBeNull();
      expect(eventsResponse.headers.get("Content-Type")).toContain("text/event-stream");
      await eventsResponse.body?.cancel();
    } finally {
      await app.shutdown();
    }
  });

  it("CS-187: shuts down while an SSE client remains connected", async () => {
    const unsubscribeSessions = vi.fn();
    const unsubscribeScanStatus = vi.fn();
    const store = {
      ...createStore(),
      subscribe: () => unsubscribeSessions,
      subscribeScanStatus: () => unsubscribeScanStatus,
    };
    const app = await createServer(0, store);
    const events = await fetch(`${app.url}/api/events`);
    const shutdown = app.shutdown();

    const completedBeforeClientCancel = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    const subscriptionsClosedBeforeClientCancel =
      unsubscribeSessions.mock.calls.length === 1 && unsubscribeScanStatus.mock.calls.length === 1;
    if (!completedBeforeClientCancel) await events.body?.cancel();
    await shutdown;

    expect(subscriptionsClosedBeforeClientCancel).toBe(true);
    expect(completedBeforeClientCancel).toBe(true);
    expect(store.shutdown).toHaveBeenCalledOnce();
  });

  it("serves the app with restrictive browser security headers", async () => {
    const webDist = mkdtempSync(join(tmpdir(), "codesesh-security-headers-"));
    writeFileSync(join(webDist, "index.html"), "<html>app shell</html>");
    const app = await createServer(0, createStore(), { webDistPath: webDist });

    try {
      const response = await fetch(app.url);
      const policy = response.headers.get("Content-Security-Policy") ?? "";

      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("script-src-attr 'none'");
      expect(policy).toContain("style-src 'self' 'unsafe-inline'");
      expect(policy).toContain("img-src 'self' data:");
      expect(policy).toContain("font-src 'self' data:");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("base-uri 'none'");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    } finally {
      await app.shutdown();
      rmSync(webDist, { recursive: true, force: true });
    }
  });

  it("CS-131: serves the web build without reading outside its root", async () => {
    const root = mkdtempSync(join(tmpdir(), "codesesh-static-root-"));
    const webDist = join(root, "web");
    mkdirSync(webDist);
    writeFileSync(join(webDist, "index.html"), "<html>app shell</html>");
    writeFileSync(join(webDist, "app.js"), "console.log('bundle')");
    // Only reachable by escaping the static root.
    const outsideMarker = "outside-static-root-marker";
    writeFileSync(join(root, "private.txt"), outsideMarker);

    const app = await createServer(0, createStore(), { webDistPath: webDist });
    const encodedDot = "%2e";
    const separators = ["/", "\\", "%2f", "%5c"];

    try {
      expect(await (await fetch(`${app.url}/app.js`)).text()).toContain("bundle");
      // SPA fallback still resolves unknown routes to the app shell.
      expect(await (await fetch(`${app.url}/sessions/anything`)).text()).toContain("app shell");

      for (const separator of separators) {
        for (const dots of ["..", `${encodedDot}${encodedDot}`]) {
          const escape = `${dots}${separator}`.repeat(4);
          const response = await fetch(`${app.url}/${escape}private.txt`);
          expect(await response.text()).not.toContain(outsideMarker);
        }
      }
    } finally {
      await app.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CS-140: serves remote access over TLS when a certificate is supplied", async () => {
    const material = createTestCertificate();
    if (!material) return; // openssl unavailable on this runner
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = resolveRemoteTransport({
      hostname: "0.0.0.0",
      tlsCertPath: material.certPath,
      tlsKeyPath: material.keyPath,
    });
    const app = await createServer(0, createStore(), {
      hostname: "0.0.0.0",
      remoteAccessToken: "tls-token",
      transport,
    });

    try {
      expect(app.url.startsWith("https://")).toBe(true);
      expect(serveOptionsLog.at(-1)?.hasCreateServer).toBe(true);

      const origin = `https://127.0.0.1:${new URL(app.url).port}`;

      expect((await httpsRequest(`${origin}/api/agents`)).status).toBe(401);
      expect(
        (await httpsRequest(`${origin}/api/agents`, { Authorization: "Bearer tls-token" })).status,
      ).toBe(200);

      const events = await httpsRequest(`${origin}/api/events?access_token=tls-token`);
      expect(events.contentType).toContain("text/event-stream");

      const shell = await httpsRequest(`${origin}/app.js`);
      expect(shell.status).toBeGreaterThan(0);
    } finally {
      await app.shutdown();
      warnSpy.mockRestore();
      rmSync(dirname(material.certPath), { recursive: true, force: true });
    }
    // Node builds its TLS context on the first https server in a process, which
    // can take tens of seconds while it loads the system trust store.
  }, 60_000);

  it("CS-140: warns that a plaintext remote listener is unprotected", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await createServer(0, createStore(), {
      hostname: "0.0.0.0",
      remoteAccessToken: "plaintext-token",
      transport: { kind: "plaintext" },
    });

    try {
      expect(app.url.startsWith("http://")).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("传输未加密"));
    } finally {
      await app.shutdown();
      warnSpy.mockRestore();
    }
  });

  it("CS-223: warns trusted proxy operators that access logs can retain tokens", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await createServer(0, createStore(), {
      hostname: "0.0.0.0",
      remoteAccessToken: "proxy-token",
      transport: { kind: "trusted-proxy" },
    });

    try {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("反向代理的访问日志"));
    } finally {
      await app.shutdown();
      warnSpy.mockRestore();
    }
  });

  it("CS-140: refuses requests that bypassed the trusted proxy", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await createServer(0, createStore(), {
      hostname: "0.0.0.0",
      remoteAccessToken: "proxy-token",
      transport: { kind: "trusted-proxy" },
    });
    const origin = `http://127.0.0.1:${new URL(app.url).port}`;
    const authorized = { Authorization: "Bearer proxy-token" };

    try {
      expect((await fetch(`${origin}/api/agents`, { headers: authorized })).status).toBe(403);
      expect(
        (
          await fetch(`${origin}/api/agents`, {
            headers: { ...authorized, "X-Forwarded-Proto": "http" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${origin}/api/agents`, {
            headers: { ...authorized, "X-Forwarded-Proto": "https, http" },
          })
        ).status,
      ).toBe(200);
      // The proxy check runs first, so a bypassed request never reaches auth.
      expect(
        (await fetch(`${origin}/api/agents`, { headers: { "X-Forwarded-Proto": "https" } })).status,
      ).toBe(401);
    } finally {
      await app.shutdown();
      warnSpy.mockRestore();
    }
  });

  it("CS-174: authenticates a loopback listener behind a trusted proxy", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(appLogger, "info");
    const app = await createServer(0, createStore(), {
      hostname: "127.0.0.1",
      remoteAccess: true,
      remoteAccessToken: "proxy-token",
      transport: { kind: "trusted-proxy" },
    });
    const origin = `http://127.0.0.1:${new URL(app.url).port}`;
    const proxyHeaders = { "X-Forwarded-Proto": "https" };

    try {
      expect(logSpy).toHaveBeenCalledWith("server.access_policy", {
        bind_category: "loopback",
        transport: "trusted-proxy",
        authentication: "token",
        loopback_authority: "disabled",
      });
      expect((await fetch(`${origin}/api/agents`, { headers: proxyHeaders })).status).toBe(401);
      expect(
        (
          await fetch(`${origin}/api/agents`, {
            headers: { ...proxyHeaders, Authorization: "Bearer proxy-token" },
          })
        ).status,
      ).toBe(200);
      const events = await fetch(`${origin}/api/events?access_token=proxy-token`, {
        headers: proxyHeaders,
      });
      expect(events.headers.get("Content-Type")).toContain("text/event-stream");
      await events.body?.cancel();
      expect(
        (
          await fetch(`${origin}/api/logs?access_token=proxy-token`, {
            method: "POST",
            headers: { ...proxyHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ event: "test" }),
          })
        ).status,
      ).toBe(401);
    } finally {
      await app.shutdown();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("CS-186: accepts a proxy's public authority on an authenticated loopback listener", async () => {
    const app = await createServer(0, createStore(), {
      hostname: "127.0.0.1",
      remoteAccess: true,
      remoteAccessToken: "proxy-token",
      transport: { kind: "trusted-proxy" },
    });
    const origin = `http://127.0.0.1:${new URL(app.url).port}`;

    try {
      expect(
        (
          await httpRequest(`${origin}/api/agents`, {
            Host: "codesesh.example.com",
            "X-Forwarded-Proto": "https",
            Authorization: "Bearer proxy-token",
          })
        ).status,
      ).toBe(200);
    } finally {
      await app.shutdown();
    }
  });

  it("CS-174: refuses an unauthenticated loopback trusted proxy", async () => {
    await expect(
      createServer(0, createStore(), {
        hostname: "127.0.0.1",
        transport: { kind: "trusted-proxy" },
      }),
    ).rejects.toThrow("Add --remote-access");
  });

  it("fails on an occupied port when fallback is disabled", async () => {
    const { blocker, port } = await createBlockedPortWithFreeNext();
    const store = createStore();

    try {
      await expect(createServer(port, store, { portFallbackAttempts: 1 })).rejects.toThrow(
        `Port ${port} 已被占用`,
      );
      expect(store.shutdown).toHaveBeenCalledOnce();
    } finally {
      await close(blocker);
    }
  });
});
