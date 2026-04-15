import { consola } from "consola";
import type { BaseAgent } from "@codesesh/core";
import type { ScanResult } from "@codesesh/core";

export function printScanResults(agents: BaseAgent[], result: ScanResult): void {
  consola.log("");
  consola.box({
    title: "CodeSesh",
    message: `v0.1.0 • ${result.sessions.length} sessions discovered`,
    style: {
      padding: 1,
      borderColor: "cyan",
    },
  });
  consola.log("");

  const rows: string[] = [];
  let availableCount = 0;

  for (const agent of agents) {
    const sessions = result.byAgent[agent.name];
    const count = sessions?.length ?? 0;
    if (count > 0) {
      availableCount++;
      rows.push(`  ${green("✔")} ${pad(agent.displayName)} ${dim(`${count} sessions`)}`);
    } else {
      rows.push(`  ${dim("✖")} ${pad(agent.displayName)} ${dim("not found")}`);
    }
  }

  consola.log(rows.join("\n"));
  consola.log("");
  consola.info(`Active: ${availableCount}/${agents.length} agents`);
  consola.log("");
}

function pad(text: string, length = 16): string {
  return text.padEnd(length);
}

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}
