import "./diagnostics-bridge.js";
import { parentPort, workerData } from "node:worker_threads";
import { createRegisteredAgents, type SessionCacheMeta } from "@codesesh/core/runtime/agents";
import {
  classifySessionTags,
  getSmartTagSourceTimestamp,
} from "@codesesh/core/runtime/diagnostics";
import { synchronizePricingGeneration } from "@codesesh/core/runtime/pricing";

interface SmartTagWorkerData {
  pricingGenerationId: number;
  agentName: string;
  sessionIds: string[];
  meta: Record<string, SessionCacheMeta>;
}

interface SmartTagWorkerResult {
  id: string;
  tags?: ReturnType<typeof classifySessionTags>;
  sourceUpdatedAt?: number;
  error?: string;
}

const data = workerData as SmartTagWorkerData;
synchronizePricingGeneration(data.pricingGenerationId);
const agents = createRegisteredAgents();
const agent = agents.find((a) => a.name === data.agentName);
const results: SmartTagWorkerResult[] = [];

if (agent) {
  agent.restoreSessionCacheMeta(data.meta);

  for (const sessionId of data.sessionIds) {
    try {
      const sessionData = agent.getSessionData(sessionId);
      results.push({
        id: sessionId,
        tags: classifySessionTags(sessionData),
        sourceUpdatedAt: getSmartTagSourceTimestamp(sessionData),
      });
    } catch (error) {
      results.push({
        id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

parentPort?.postMessage(results);
