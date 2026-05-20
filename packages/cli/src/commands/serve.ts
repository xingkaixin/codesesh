import { defineCommand } from "citty";
import { createServer, getServerStartupErrorMessage } from "../server.js";
import { printScanResults } from "../output.js";
import { createRegisteredAgents, refreshPricingCache, type ScanOptions } from "@codesesh/core";
import { LiveScanStore } from "../live-scan.js";
import {
  DEFAULT_PORT,
  DEFAULT_PORT_FALLBACK_ATTEMPTS,
  hasExplicitPortArg,
  parsePort,
} from "../ports.js";

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Scan sessions and start web server",
  },
  args: {
    port: {
      type: "string",
      alias: "p",
      default: String(DEFAULT_PORT),
    },
    agent: {
      type: "string",
      alias: "a",
    },
    cwd: {
      type: "string",
    },
    from: {
      type: "string",
    },
    to: {
      type: "string",
    },
    json: {
      type: "boolean",
      alias: "j",
      default: false,
    },
    "no-open": {
      type: "boolean",
      default: false,
    },
  },
  async run({ args }) {
    const port = parsePort(args.port as string | undefined);
    const explicitPort = hasExplicitPortArg(process.argv.slice(2));
    const noOpen = args["no-open"] as boolean;
    const jsonOnly = args.json as boolean;
    void refreshPricingCache();
    const scanOptions: ScanOptions = {
      agents: args.agent
        ? (args.agent as string).split(",").map((agent) => agent.trim())
        : undefined,
      cwd: args.cwd as string | undefined,
    };
    const listDefaultFrom = args.from ? new Date(args.from as string).getTime() : undefined;
    const listDefaultTo = args.to ? new Date(args.to as string).getTime() : undefined;
    const store = new LiveScanStore(
      !jsonOnly,
      scanOptions,
      jsonOnly ? {} : { from: listDefaultFrom, to: listDefaultTo },
    );

    await store.initialize();
    const result = store.getSnapshot();

    const agents = createRegisteredAgents();

    if (jsonOnly) {
      const { getAgentInfoMap } = await import("@codesesh/core");
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
        sessions: result.sessions,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Print console output
    printScanResults(agents, result);

    // Start server
    let url: string;
    try {
      ({ url } = await createServer(port, store, {
        defaultSessionFrom: listDefaultFrom,
        defaultSessionTo: listDefaultTo,
        portFallbackAttempts: explicitPort ? 1 : DEFAULT_PORT_FALLBACK_ATTEMPTS,
      }));
    } catch (error) {
      console.error(getServerStartupErrorMessage(error, port));
      process.exit(1);
    }

    if (!noOpen) {
      const open = (await import("open")).default;
      await open(url);
    }
  },
});
