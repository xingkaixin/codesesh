import "./diagnostics-bridge.js";
import { defineCommand, runMain } from "citty";
import { createServer, getServerStartupErrorMessage } from "./server.js";
import { LiveScanStore } from "./live-scan.js";
import { printScanResults } from "./output.js";
import { VERSION } from "./version.js";
import { appLogger } from "./logging.js";
import {
  buildSessionIndexOutput,
  formatCacheFailureDiagnostics,
  formatScanFailureDiagnostics,
} from "./session-index-output.js";
import {
  resolvePublicOrigin,
  resolveRemoteAccessPolicy,
  resolveRemoteTransport,
  type RemoteTransport,
} from "./remote-access.js";
import {
  buildCliRuntimePlan,
  parseSessionUri,
  redactStartupUrl,
  resolveStartupUrl,
} from "./runtime-plan.js";
import {
  DEFAULT_PORT,
  DEFAULT_PORT_FALLBACK_ATTEMPTS,
  hasExplicitPortArg,
  parsePort,
} from "./ports.js";
import { createRegisteredAgents, perf } from "@codesesh/core";
import { startPricingRefresh } from "./pricing-refresh.js";

// Node's default reaction to an unhandled rejection is to terminate without
// touching the app log; record it first, then let the crash proceed.
process.on("unhandledRejection", (reason) => {
  appLogger.error("process.unhandled_rejection", { error: reason });
  throw reason;
});

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
    "tls-cert": {
      type: "string",
      description: "Path to a TLS certificate; serve remote access over HTTPS",
    },
    "tls-key": {
      type: "string",
      description: "Path to the TLS private key matching --tls-cert",
    },
    "trust-proxy": {
      type: "boolean",
      description: "A reverse proxy in front of CodeSesh terminates TLS",
      default: false,
    },
    "public-url": {
      type: "string",
      description: "Public HTTPS origin served by the trusted reverse proxy",
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

    let transport: RemoteTransport;
    let publicOrigin: string | undefined;
    try {
      transport = resolveRemoteTransport({
        hostname,
        tlsCertPath: args["tls-cert"] as string | undefined,
        tlsKeyPath: args["tls-key"] as string | undefined,
        trustProxy: args["trust-proxy"] as boolean,
      });
      publicOrigin = resolvePublicOrigin(args["public-url"] as string | undefined, transport);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (resolveRemoteAccessPolicy(hostname, transport).remoteAccessRequired && !remoteAccess) {
      console.error(
        `Refusing to expose CodeSesh on ${hostname} without explicit remote access. Add --remote-access to continue.`,
      );
      process.exit(1);
    }

    if (trace) {
      perf.enable();
    }

    // Parsed named fields only — raw argv is the one unredacted sink in the
    // logging pipeline, and would capture any future credential-bearing flag.
    appLogger.info("cli.start", {
      version: VERSION,
      port,
      host: hostname,
      transport: transport.kind,
      public_url: publicOrigin,
      remote_access: remoteAccess,
      json: jsonOnly,
      no_open: noOpen,
      cache: useCache,
      clear_cache: clearCache,
      trace,
      log_path: appLogger.getLogPath(),
    });

    if (clearCache) {
      const { clearCache: clear } = await import("@codesesh/core");
      clear();
      appLogger.info("cache.clear");
      console.log("Cache cleared.");
    }

    // Owns the refresh: bounded, cancellable, and published only between scans
    // so a scan never spans two price generations.
    const pricingRefresh = startPricingRefresh();

    // Parse session URI if provided
    let targetSession: { agent: string; sessionId: string } | null = null;
    if (args.session) {
      targetSession = parseSessionUri(args.session as string);
      if (!targetSession) {
        console.error(`Invalid session format: ${args.session}. Expected: agent://session-id`);
        process.exit(1);
      }
    }

    const { listWindow, scanOptions, startupScanOptions } = buildCliRuntimePlan(
      {
        agent: args.agent as string | undefined,
        cwd: args.cwd as string | undefined,
        from: args.from as string | undefined,
        to: args.to as string | undefined,
        days: args.days as string | undefined,
        jsonOnly,
        targetSession,
        useCache,
      },
      { currentWorkingDirectory: process.cwd() },
    );
    const { from: listDefaultFrom, to: listDefaultTo, days: listDefaultDays } = listWindow;

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
      // Nothing will consume a later generation, so stop waiting for it.
      await pricingRefresh.cancel();
      const scanFailureDiagnostics = formatScanFailureDiagnostics(result);
      if (scanFailureDiagnostics.length > 0) {
        await store.shutdown();
        for (const diagnostic of scanFailureDiagnostics) console.error(diagnostic);
        process.exitCode = 1;
        return;
      }
      for (const diagnostic of formatCacheFailureDiagnostics(result)) console.error(diagnostic);
      const output = buildSessionIndexOutput(result, { from: listDefaultFrom, to: listDefaultTo });
      appLogger.info("cli.json_output", {
        sessions: output.sessions.length,
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
        transport,
        publicUrl: publicOrigin,
      });
    } catch (error) {
      console.error(getServerStartupErrorMessage(error, port));
      process.exit(1);
    }

    const { url } = app;
    if (!jsonOnly) {
      // The startup scan has finished and background scans have not begun.
      pricingRefresh.publish();
      store.startBackgroundRefresh();
    }
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      appLogger.info("cli.shutdown", { signal });
      await pricingRefresh.cancel();
      await app.shutdown();
      process.exit(0);
    };
    // If shutdown rejects, process.exit(0) inside it never runs; log and
    // exit non-zero instead of leaving an unhandled rejection behind.
    const shutdownOnSignal = (signal: NodeJS.Signals) => {
      shutdown(signal).catch((error) => {
        appLogger.error("cli.shutdown_failed", { signal, error });
        process.exit(1);
      });
    };
    process.once("SIGINT", shutdownOnSignal);
    process.once("SIGTERM", shutdownOnSignal);

    console.log(`  ${url}`);
    console.log("");
    appLogger.info("cli.ready", {
      url: redactStartupUrl(url),
      duration_ms: Math.round(performance.now() - startedAt),
      log_path: appLogger.getLogPath(),
    });

    if (!noOpen) {
      const open = (await import("open")).default;
      const targetUrl = resolveStartupUrl(url, targetSession);
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
