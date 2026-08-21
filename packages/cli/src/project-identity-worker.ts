import "./diagnostics-bridge.js";
import { parentPort } from "node:worker_threads";
import { computeIdentityProjection, type ProjectIdentityProjection } from "@codesesh/core/runtime";

export interface ProjectIdentityWorkerRequest {
  type: "resolve";
  requestId: number;
  cwd: string;
}

export type ProjectIdentityWorkerMessage =
  | {
      type: "resolved";
      requestId: number;
      projection: ProjectIdentityProjection;
    }
  | {
      type: "failed";
      requestId: number;
      error: string;
    };

function resolveIdentity(request: ProjectIdentityWorkerRequest): void {
  try {
    parentPort?.postMessage({
      type: "resolved",
      requestId: request.requestId,
      projection: computeIdentityProjection(request.cwd),
    } satisfies ProjectIdentityWorkerMessage);
  } catch (error) {
    parentPort?.postMessage({
      type: "failed",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ProjectIdentityWorkerMessage);
  }
}

parentPort?.on("message", (message: ProjectIdentityWorkerRequest) => {
  if (message.type === "resolve") resolveIdentity(message);
});
