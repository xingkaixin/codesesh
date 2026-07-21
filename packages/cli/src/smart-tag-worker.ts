import "./diagnostics-bridge.js";
import { parentPort, workerData } from "node:worker_threads";
import {
  createRegisteredAgents,
  classifySessionTags,
  getSmartTagSourceTimestamp,
  type SessionCacheMeta,
} from "@codesesh/core";

interface SmartTagWorkerData {
  agentName: string;
  sessionIds: string[];
  meta: Record<string, Record<string, unknown>>;
}

interface SmartTagWorkerResult {
  id: string;
  tags?: ReturnType<typeof classifySessionTags>;
  sourceUpdatedAt?: number;
  error?: string;
}

const data = workerData as SmartTagWorkerData;
const agents = createRegisteredAgents();
const agent = agents.find((a) => a.name === data.agentName);
const results: SmartTagWorkerResult[] = [];

if (agent && agent.setSessionMetaMap) {
  agent.setSessionMetaMap(new Map(Object.entries(data.meta)) as Map<string, SessionCacheMeta>);

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
