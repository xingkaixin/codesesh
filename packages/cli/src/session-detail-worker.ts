import "./diagnostics-bridge.js";
import { parentPort, workerData } from "node:worker_threads";
import { createRegisteredAgents, type SessionCacheMeta } from "@codesesh/core/runtime/agents";
import {
  closeCacheStorage,
  materializeSessionDetailResponse,
  type IdentifiedSessionHead,
  type SessionDetailResponseResult,
  type SessionReference,
} from "@codesesh/core/runtime/discovery";
import { synchronizePricingGeneration } from "@codesesh/core/runtime/pricing";
import { appLogger, type LogContext } from "./logging.js";
import { acknowledgeWorkerLogDrain } from "./worker-log-drain.js";

export interface SessionDetailWorkerRequest {
  reference: SessionReference;
  head?: IdentifiedSessionHead;
  meta: Record<string, SessionCacheMeta>;
  messageCursor?: string;
  pricingGenerationId: number;
  logContext?: LogContext;
}

export type SessionDetailWorkerMessage =
  | { type: "result"; result: SessionDetailResponseResult }
  | { type: "error"; error: string };

const workerPort = parentPort;
workerPort?.on("message", (message: unknown) => {
  acknowledgeWorkerLogDrain(workerPort, message);
});

const request = workerData as SessionDetailWorkerRequest;
const terminalMessage = appLogger.restoreContext(
  request.logContext ?? {},
  (): SessionDetailWorkerMessage => {
    try {
      synchronizePricingGeneration(request.pricingGenerationId);
      const agent = createRegisteredAgents().find(
        (item) => item.name === request.reference.agentName,
      );
      const sessions = request.head ? [request.head] : [];
      agent?.restoreSessionCacheMeta(request.meta);
      const result = materializeSessionDetailResponse(
        {
          agents: agent ? [agent] : [],
          sessions,
          byAgent: { [request.reference.agentName]: sessions },
        },
        request.reference,
        { messageCursor: request.messageCursor },
      );
      if (result.status === "found") {
        const { messages, ...data } = result.data;
        return {
          type: "result",
          result: {
            status: "found-json",
            data,
            messages: messages.map((message) => JSON.stringify(message)),
            messageCount: messages.length,
            sentMessageCount: messages.length,
          },
        };
      }
      return {
        type: "result",
        result:
          result.status === "found-json" ? { ...result, messages: [...result.messages] } : result,
      };
    } catch (error) {
      return {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        closeCacheStorage();
      } catch (error) {
        appLogger.error("session_detail.worker.close_failed", { error });
      }
    }
  },
);
parentPort?.postMessage(terminalMessage);
