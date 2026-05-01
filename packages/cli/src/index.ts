import { defineCommand, runMain } from "citty";
import { createServer, getServerStartupErrorMessage } from "./server.js";
import { LiveScanStore } from "./live-scan.js";
import { printScanResults } from "./output.js";
import { VERSION } from "./version.js";
import { appLogger } from "./logging.js";
import { createRegisteredAgents, getAgentInfoMap, type ScanOptions, perf } from "@codesesh/core";

function parseDateToTimestamp(dateStr: string): number {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`);
  }
  return date.getTime();
}

function parseSessionUri(uri: string): { agent: string; sessionId: string } | null {
  const match = uri.match(/^([a-z]+):\/\/(.+)$/i);
  if (!match) return null;
  return { agent: match[1]!, sessionId: match[2]! };
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
      default: "4321",
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
    const port = parseInt(args.port as string, 10) || 4321;
    const noOpen = args.noOpen as boolean;
    const jsonOnly = args.json as boolean;
    const trace = args.trace as boolean;
    const useCache = args.cache as boolean;
    const clearCache = args["clear-cache"] as boolean;

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

    // Resolve app-level default window (shared across /api/agents, /sessions, /dashboard).
    // Priority: --from (absolute) over --days (relative).
    let listDefaultFrom: number | undefined;
    let listDefaultDays: number | undefined;
    if (args.from) {
      listDefaultFrom = parseDateToTimestamp(args.from as string);
    } else {
      const days = parseInt(args.days as string, 10);
      if (!Number.isNaN(days) && days > 0) {
        listDefaultFrom = Date.now() - days * 24 * 60 * 60 * 1000;
        listDefaultDays = days;
      }
    }
    const listDefaultTo = args.to ? parseDateToTimestamp(args.to as string) : undefined;

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

    const store = new LiveScanStore(!jsonOnly, scanOptions, startupScanOptions);
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
    printScanResults(agents, result);

    // Start server
    let url: string;
    try {
      ({ url } = await createServer(port, store, {
        defaultSessionFrom: listDefaultFrom,
        defaultSessionTo: listDefaultTo,
        defaultSessionDays: listDefaultDays,
      }));
    } catch (error) {
      console.error(getServerStartupErrorMessage(error, port));
      process.exit(1);
    }

    console.log(`  ${url}`);
    console.log("");
    appLogger.info("cli.ready", {
      url,
      duration_ms: Math.round(performance.now() - startedAt),
      log_path: appLogger.getLogPath(),
    });

    if (!noOpen) {
      const open = (await import("open")).default;
      const targetUrl = targetSession
        ? `${url}/${targetSession.agent.toLowerCase()}/${targetSession.sessionId}`
        : url;
      appLogger.info("browser.open", { url: targetUrl });
      await open(targetUrl);
    }
  },
});

if (process.argv.slice(2).includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

runMain(main);
