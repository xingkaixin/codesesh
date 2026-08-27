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

export interface SessionDetailWorkerRequest {
  reference: SessionReference;
  head?: IdentifiedSessionHead;
  meta: Record<string, SessionCacheMeta>;
  messageCursor?: string;
  pricingGenerationId: number;
}

export type SessionDetailWorkerMessage =
  | { type: "result"; result: SessionDetailResponseResult }
  | { type: "error"; error: string };

const request = workerData as SessionDetailWorkerRequest;
try {
  synchronizePricingGeneration(request.pricingGenerationId);
  const agent = createRegisteredAgents().find((item) => item.name === request.reference.agentName);
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
    parentPort?.postMessage({
      type: "result",
      result: {
        status: "found-json",
        data,
        messages: messages.map((message) => JSON.stringify(message)),
        messageCount: messages.length,
        sentMessageCount: messages.length,
      },
    } satisfies SessionDetailWorkerMessage);
  } else {
    parentPort?.postMessage({
      type: "result",
      result:
        result.status === "found-json" ? { ...result, messages: [...result.messages] } : result,
    } satisfies SessionDetailWorkerMessage);
  }
} catch (error) {
  parentPort?.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
  } satisfies SessionDetailWorkerMessage);
} finally {
  closeCacheStorage();
}
