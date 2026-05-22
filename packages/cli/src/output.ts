import { consola } from "consola";
import type { BaseAgent } from "@codesesh/core";
import { VERSION } from "./version.js";

export function printScanResults(agents: BaseAgent[]): void {
  consola.log("");
  consola.box({
    title: "CodeSesh",
    message: `v${VERSION} • local session browser`,
    style: {
      padding: 1,
      borderColor: "cyan",
    },
  });
  consola.log("");
  consola.info(
    `Indexing ${agents.map((agent) => agent.displayName).join(", ")} sessions in the background.`,
  );
  consola.info("The Web UI will update automatically as sessions are discovered.");
  consola.log("");
}
