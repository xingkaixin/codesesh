import { createServer as createNodeServer, type Server as NodeServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const serveOptionsLog = vi.hoisted(() => [] as { hostname?: string; port?: number }[]);

vi.mock("@hono/node-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hono/node-server")>();
  return {
    ...actual,
    serve: (options: Parameters<typeof actual.serve>[0]) => {
      serveOptionsLog.push({
        hostname: (options as { hostname?: string }).hostname,
        port: (options as { port?: number }).port,
      });
      return actual.serve(options);
    },
  };
});

function createStore() {
  return {
    getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }),
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

  it("binds to the provided hostname and reflects it in the url", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const app = await createServer(0, createStore(), { hostname: "0.0.0.0" });

      expect(serveOptionsLog.at(-1)?.hostname).toBe("0.0.0.0");
      expect(app.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("0.0.0.0"));

      await app.shutdown();
    } finally {
      warnSpy.mockRestore();
    }
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
