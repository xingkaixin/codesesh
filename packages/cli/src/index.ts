import { defineCommand, runMain } from "citty";
import { createServer } from "./server.js";
import { printScanResults } from "./output.js";
import { scanSessionsAsync, createRegisteredAgents, getAgentInfoMap, type ScanOptions, perf } from "@agent-lens/core";

const VERSION = "0.1.0";

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
    name: "agent-lens",
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
      description: "Only include sessions from the last N days (0 = all time)",
      default: "7",
    },
    cwd: {
      type: "string",
      description: "Filter to sessions from a specific project directory (use '.' for current dir)",
    },
    from: {
      type: "string",
      description: "Sessions created after this date, YYYY-MM-DD (overrides --days)",
    },
    to: {
      type: "string",
      description: "Sessions created before this date (YYYY-MM-DD)",
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
    const port = parseInt(args.port as string, 10) || 4321;
    const noOpen = args.noOpen as boolean;
    const jsonOnly = args.json as boolean;
    const trace = args.trace as boolean;
    const useCache = args.cache as boolean;
    const clearCache = args["clear-cache"] as boolean;

    if (trace) {
      perf.enable();
    }

    if (clearCache) {
      const { clearCache: clear } = await import("@agent-lens/core");
      clear();
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
    if (cwdFilter === '.') {
      cwdFilter = process.cwd();
    }

    // Resolve from timestamp: --from takes priority over --days
    let fromTimestamp: number | undefined;
    if (args.from) {
      fromTimestamp = parseDateToTimestamp(args.from as string);
    } else {
      const days = parseInt(args.days as string, 10);
      if (!Number.isNaN(days) && days > 0) {
        fromTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;
      }
    }

    // Build scan options
    const scanOptions: ScanOptions = {
      agents: targetSession
        ? [targetSession.agent]
        : args.agent
          ? (args.agent as string).split(",").map((a) => a.trim())
          : undefined,
      cwd: cwdFilter,
      from: fromTimestamp,
      to: args.to ? parseDateToTimestamp(args.to as string) : undefined,
      useCache: useCache,
    };

    // Scan sessions (parallel)
    const result = await scanSessionsAsync(scanOptions);

    if (trace) {
      console.log(perf.getReport());
    }

    if (jsonOnly) {
      const info = getAgentInfoMap(
        Object.fromEntries(
          Object.entries(result.byAgent).map(([k, v]) => [k, v.length]),
        ),
      );
      const output = {
        agents: info.map(({ name, displayName, count }) => ({ name, displayName, count, available: count > 0 })),
        sessions: result.sessions,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Print console output
    const agents = createRegisteredAgents();
    printScanResults(agents, result);

    // Start server
    const { url } = await createServer(port, result);

    console.log(`  http://localhost:${port}`);
    console.log("");

    if (!noOpen) {
      const open = (await import("open")).default;
      const targetUrl = targetSession
        ? `${url}/${targetSession.agent.toLowerCase()}/${targetSession.sessionId}`
        : url;
      await open(targetUrl);
    }
  },
});

if (process.argv.slice(2).includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

runMain(main);
