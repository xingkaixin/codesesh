import "./diagnostics-bridge.js";
import { defineCommand, runMain } from "citty";
import { createServer, getServerStartupErrorMessage } from "./server.js";
import { LiveScanStore } from "./live-scan.js";
import { printScanResults } from "./output.js";
import { VERSION } from "./version.js";
import { appLogger } from "./logging.js";
import { isLoopbackHostname } from "./remote-access.js";
import { resolveTimeWindow } from "./time-window-resolution.js";
import {
  DEFAULT_PORT,
  DEFAULT_PORT_FALLBACK_ATTEMPTS,
  hasExplicitPortArg,
  parsePort,
} from "./ports.js";
import {
  createRegisteredAgents,
  getAgentInfoMap,
  refreshPricingCache,
  type ScanOptions,
  perf,
} from "@codesesh/core";

function parseSessionUri(uri: string): { agent: string; sessionId: string } | null {
  const match = uri.match(/^([a-z]+):\/\/(.+)$/i);
  if (!match) return null;
  return { agent: match[1]!, sessionId: match[2]! };
}

function appendStartupPath(startupUrl: string, path: string): string {
  const url = new URL(startupUrl);
  url.pathname = path;
  return url.toString();
}

function redactStartupUrl(startupUrl: string): string {
  const url = new URL(startupUrl);
  for (const key of url.searchParams.keys()) {
    url.searchParams.set(key, "[redacted]");
  }
  return url.toString();
}

const main = defineCommand({
  meta: {
    name: "codesesh",
    description: "Discover, aggregate, and visualize AI coding agent sessions",
    version: VERSION,
  },
  args: {
    port: {
      type: "string",
      alias: "p",
      description: "HTTP server port",
      default: String(DEFAULT_PORT),
    },
    host: {
      type: "string",
      description: "HTTP server bind address (default 127.0.0.1, local access only)",
      default: "127.0.0.1",
    },
    "remote-access": {
      type: "boolean",
      description: "Allow authenticated access when binding to a non-loopback address",
      default: false,
    },
    agent: {
      type: "string",
      alias: "a",
      description: "Filter to specific agent(s), comma-separated",
    },
    days: {
      type: "string",
      alias: "d",
      description: "Only include sessions active in the last N days (0 = all time)",
      default: "7",
    },
    cwd: {
      type: "string",
      description: "Filter to sessions from a specific project directory (use '.' for current dir)",
    },
    from: {
      type: "string",
      description: "Sessions active after this date, YYYY-MM-DD (overrides --days)",
    },
    to: {
      type: "string",
      description: "Sessions active before this date (YYYY-MM-DD)",
    },
    session: {
      type: "string",
      alias: "s",
      description: "Directly open a specific session (agent://session-id)",
    },
    json: {
      type: "boolean",
      alias: "j",
      description: "Output session index as JSON to stdout (no server)",
      default: false,
    },
    noOpen: {
      type: "boolean",
      description: "Don't auto-open browser",
      default: false,
    },
    trace: {
      type: "boolean",
      description: "Show performance trace logs",
      default: false,
    },
    cache: {
      type: "boolean",
      description: "Use cached scan results if available",
      default: true,
    },
    "clear-cache": {
      type: "boolean",
      description: "Clear scan cache before starting",
      default: false,
    },
  },
  async run({ args }) {
    const startedAt = performance.now();
    const port = parsePort(args.port as string | undefined);
    const explicitPort = hasExplicitPortArg(process.argv.slice(2));
    const noOpen = args.noOpen as boolean;
    const jsonOnly = args.json as boolean;
    const trace = args.trace as boolean;
    const useCache = args.cache as boolean;
    const clearCache = args["clear-cache"] as boolean;
    const hostname = args.host as string;
    const remoteAccess = args["remote-access"] as boolean;

    if (!isLoopbackHostname(hostname) && !remoteAccess) {
      console.error(
        `Refusing to expose CodeSesh on ${hostname} without authentication. Add --remote-access to continue.`,
      );
      process.exit(1);
    }

    if (trace) {
      perf.enable();
    }

    appLogger.info("cli.start", {
      version: VERSION,
      argv: process.argv.slice(2),
      port,
      json: jsonOnly,
      no_open: noOpen,
      cache: useCache,
      log_path: appLogger.getLogPath(),
    });

    if (clearCache) {
      const { clearCache: clear } = await import("@codesesh/core");
      clear();
      appLogger.info("cache.clear");
      console.log("Cache cleared.");
    }

    void refreshPricingCache();

    // Parse session URI if provided
    let targetSession: { agent: string; sessionId: string } | null = null;
    if (args.session) {
      targetSession = parseSessionUri(args.session as string);
      if (!targetSession) {
        console.error(`Invalid session format: ${args.session}. Expected: agent://session-id`);
        process.exit(1);
      }
    }

    // Resolve cwd filter: '.' => process.cwd()
    let cwdFilter = args.cwd as string | undefined;
    if (cwdFilter === ".") {
      cwdFilter = process.cwd();
    }

    const {
      from: listDefaultFrom,
      to: listDefaultTo,
      days: listDefaultDays,
    } = resolveTimeWindow({
      mode: "cli",
      from: args.from as string | undefined,
      to: args.to as string | undefined,
      days: args.days as string | undefined,
    });

    const scanOptions: ScanOptions = {
      agents: targetSession
        ? [targetSession.agent]
        : args.agent
          ? (args.agent as string).split(",").map((a) => a.trim())
          : undefined,
      cwd: cwdFilter,
      useCache: useCache,
    };
    const startupScanOptions =
      targetSession || jsonOnly ? {} : { from: listDefaultFrom, to: listDefaultTo };

    const store = new LiveScanStore({
      watchEnabled: !jsonOnly,
      scanOptions,
      startupScanOptions,
      deferInitialRefresh: !jsonOnly,
    });
    await store.initialize();
    const result = store.getSnapshot();
    appLogger.info("cli.scan_ready", {
      duration_ms: Math.round(performance.now() - startedAt),
      sessions: result.sessions.length,
      agents: Object.fromEntries(
        Object.entries(result.byAgent).map(([key, value]) => [key, value.length]),
      ),
      startup_from: startupScanOptions.from,
      startup_to: startupScanOptions.to,
    });

    if (trace) {
      console.log(perf.getReport());
    }

    if (jsonOnly) {
      // Apply --days/--from/--to window to the JSON output so CLI semantics are preserved.
      const windowed = result.sessions.filter((s) => {
        const activity = s.time_updated ?? s.time_created;
        if (listDefaultFrom != null && activity < listDefaultFrom) return false;
        if (listDefaultTo != null && activity > listDefaultTo) return false;
        return true;
      });
      const info = getAgentInfoMap(
        Object.fromEntries(Object.entries(result.byAgent).map(([k, v]) => [k, v.length])),
      );
      const output = {
        agents: info.map(({ name, displayName, count }) => ({
          name,
          displayName,
          count,
          available: count > 0,
        })),
        sessions: windowed,
      };
      appLogger.info("cli.json_output", {
        sessions: windowed.length,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Print console output
    const agents = createRegisteredAgents();
    printScanResults(agents);

    // Start server
    let app: Awaited<ReturnType<typeof createServer>>;
    try {
      app = await createServer(port, store, {
        defaultSessionFrom: listDefaultFrom,
        defaultSessionTo: listDefaultTo,
        defaultSessionDays: listDefaultDays,
        portFallbackAttempts: explicitPort ? 1 : DEFAULT_PORT_FALLBACK_ATTEMPTS,
        hostname,
        remoteAccess,
      });
    } catch (error) {
      console.error(getServerStartupErrorMessage(error, port));
      process.exit(1);
    }

    const { url } = app;
    if (!jsonOnly) {
      store.startBackgroundRefresh();
    }
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      appLogger.info("cli.shutdown", { signal });
      await app.shutdown();
      process.exit(0);
    };
    process.once("SIGINT", (signal) => {
      void shutdown(signal);
    });
    process.once("SIGTERM", (signal) => {
      void shutdown(signal);
    });

    console.log(`  ${url}`);
    console.log("");
    appLogger.info("cli.ready", {
      url: redactStartupUrl(url),
      duration_ms: Math.round(performance.now() - startedAt),
      log_path: appLogger.getLogPath(),
    });

    if (!noOpen) {
      const open = (await import("open")).default;
      const targetUrl = targetSession
        ? appendStartupPath(url, `/${targetSession.agent.toLowerCase()}/${targetSession.sessionId}`)
        : url;
      appLogger.info("browser.open", { url: redactStartupUrl(targetUrl) });
      await open(targetUrl);
    }
  },
});

if (process.argv.slice(2).includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

runMain(main);
