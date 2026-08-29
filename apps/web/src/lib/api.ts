export * from "./api-contract";
export { ApiRequestError } from "./api-client";

import { createApiClient } from "./api-client";
import { createClientTelemetry } from "./client-telemetry";
import { resolveRemoteAccess } from "./remote-access";
import { createSessionUpdateSubscriber } from "./session-updates";

const remoteAccess = resolveRemoteAccess();
export const apiClient = createApiClient(remoteAccess);

export const {
  fetchConfig,
  fetchScanStatus,
  fetchAgents,
  fetchProjects,
  fetchProject,
  fetchSessions,
  fetchSessionData,
  fetchDashboard,
  fetchSearchResults,
  fetchBookmarks,
  upsertBookmark,
  importBookmarks,
  deleteBookmark,
  upsertSessionAlias,
  deleteSessionAlias,
} = apiClient;

export const { logClientEvent } = createClientTelemetry(remoteAccess);
export const subscribeSessionUpdates = createSessionUpdateSubscriber(remoteAccess);
