export { ApiRequestError } from "./api-client";
export type { DashboardFilters, SearchRequestOptions } from "./api-client";

import { createApiClient } from "./api-client";
import { createClientTelemetry } from "./client-telemetry";
import { resolveRemoteAccess } from "./remote-access";
import { createSessionUpdateSubscriber } from "./session-updates";

const remoteAccess = resolveRemoteAccess();
export const apiClient = createApiClient(remoteAccess);

export const {
  fetchNodes,
  fetchRescanHistory,
  cancelRescan,
  createPairingToken,
  fetchPairingStatus,
  updateNode,
  setSourceIgnored,
  requestRescan,
  fetchSourceSessions,
  fetchConfig,
  fetchScanStatus,
  fetchAgents,
  fetchProjects,
  fetchProject,
  fetchSessions,
  fetchSessionData,
  fetchSessionMatches,
  fetchDashboard,
  fetchSearchResults,
  fetchBookmarks,
  upsertBookmark,
  importBookmarks,
  deleteBookmark,
  upsertSessionAlias,
  deleteSessionAlias,
  fetchPricingOverrides,
  refreshModelPricing,
  fetchUnmatchedModels,
  fetchOfficialPricingModels,
  savePricingOverride,
  acknowledgeOfficialPricing,
  deletePricingOverride,
} = apiClient;

export const { logClientEvent } = createClientTelemetry(remoteAccess);
export const subscribeSessionUpdates = createSessionUpdateSubscriber(remoteAccess);
