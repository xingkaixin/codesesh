/**
 * Per-model cost wire type. It lives in the contract (browser-safe) even though
 * only the SQLite message cache can produce it, so the web layer can consume it
 * without importing anything from `discovery/`.
 */

export interface ModelCostEntry {
  model: string;
  cost: number;
  costRecorded: number;
  costEstimated: number;
}
