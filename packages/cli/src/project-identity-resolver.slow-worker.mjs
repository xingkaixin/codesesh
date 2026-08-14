import { spawnSync } from "node:child_process";
import { parentPort } from "node:worker_threads";

parentPort?.on("message", (message) => {
  if (message?.type !== "resolve") return;

  spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: message.cwd });
  parentPort?.postMessage({
    type: "resolved",
    requestId: message.requestId,
    projection: {
      identity: { kind: "path", key: message.cwd, displayName: "slow-fixture" },
      resolverRevision: "test",
      inputSignature: "test",
    },
  });
});
