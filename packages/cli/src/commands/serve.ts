import { defineCommand } from "citty";
import { createServer } from "../server.js";
import { printScanResults } from "../output.js";
import { createRegisteredAgents } from "@codesesh/core";
import { LiveScanStore } from "../live-scan.js";

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Scan sessions and start web server",
  },
  args: {
    port: {
      type: "string",
      alias: "p",
      default: "4321",
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
    const port = parseInt(args.port as string, 10) || 4321;
    const noOpen = args["no-open"] as boolean;
    const jsonOnly = args.json as boolean;
    const store = new LiveScanStore(!jsonOnly);

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
    const { url } = await createServer(port, store);

    if (!noOpen) {
      const open = (await import("open")).default;
      await open(url);
    }
  },
});
