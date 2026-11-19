import type {
  AppConfig,
  ModelPriceOverrideView,
  PricingOverridesResponse,
  PricingHistoryPhase,
  UnmatchedModelStat,
  UpsertPricingOverrideRequest,
} from "@codesesh/contract";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  acknowledgeOfficialPricing,
  deletePricingOverride,
  fetchPricingOverrides,
  fetchUnmatchedModels,
  refreshModelPricing,
  savePricingOverride,
} from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { useScanStatus } from "./useScanStatus";

/** Unmatched counts are only known once the window has been counted; until then there is no number. */
export type UnmatchedPricing =
  | { status: "pending" }
  | { status: "error" }
  | {
      status: "ready";
      models: readonly UnmatchedModelStat[];
      updatedAt: number;
      refreshing: boolean;
    };

export interface ModelPricingState {
  overrides: readonly ModelPriceOverrideView[] | undefined;
  overridesError: boolean;
  unmatched: UnmatchedPricing;
  retryOverrides: () => void;
  retryUnmatched: () => void;
  saveOverride: (request: UpsertPricingOverrideRequest) => Promise<PricingOverridesResponse>;
  acknowledgeOfficial: (model: string) => Promise<PricingOverridesResponse>;
  deleteOverride: (model: string) => Promise<PricingOverridesResponse>;
  refreshModels: () => void;
  refreshStatus: "idle" | "pending" | "changed" | "unchanged" | "error";
  historyPhase?: PricingHistoryPhase;
  isMutating: boolean;
  pendingModel: string | null;
}

async function invalidateRepricedQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.pricingUnmatcheds }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboards }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionProjections }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionDetails }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
    queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agentCatalogs }),
  ]);
}

function invalidateCatalog(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.pricingModelLists });
  void queryClient.invalidateQueries({ queryKey: queryKeys.pricingOverrides });
}

export function useModelPricing(
  window: AppConfig["window"] | null,
  enabled: boolean,
): ModelPricingState {
  const queryClient = useQueryClient();
  const scanStatus = useScanStatus();
  const active = enabled && window !== null;
  const from = window?.from;
  const to = window?.to;
  const days = window?.days;

  const overridesQuery = useQuery<PricingOverridesResponse>({
    queryKey: queryKeys.pricingOverrides,
    queryFn: fetchPricingOverrides,
    enabled,
    staleTime: 60_000,
  });

  const unmatchedQuery = useQuery({
    queryKey: queryKeys.pricingUnmatched(from, to, days),
    queryFn: () => fetchUnmatchedModels(from, to, days),
    enabled: active,
    staleTime: 60_000,
  });

  const scanActive = Boolean(scanStatus?.active || scanStatus?.backfill.active);
  const wasScanActiveRef = useRef(scanActive);

  useEffect(() => {
    const wasActive = wasScanActiveRef.current;
    wasScanActiveRef.current = scanActive;
    if (active && wasActive && !scanActive) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pricingUnmatcheds });
    }
  }, [active, queryClient, scanActive]);

  const history = scanStatus?.pricingHistory;
  const previousHistory = useRef(history);
  useEffect(() => {
    if (!enabled || !history) return;
    const previous = previousHistory.current;
    previousHistory.current = history;
    const published = history.generation !== previous?.generation;
    if (published) invalidateCatalog(queryClient);
    if (history.phase === "current" && (published || previous?.phase !== "current")) {
      void invalidateRepricedQueries(queryClient);
    }
  }, [enabled, history, queryClient]);

  const refreshMutation = useMutation({
    mutationFn: refreshModelPricing,
    onSuccess: ({ changed }) => {
      if (changed) invalidateCatalog(queryClient);
    },
  });

  const reloadOverrides = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.pricingOverrides });
  const applyRepricedOverrides = () =>
    Promise.all([reloadOverrides(), invalidateRepricedQueries(queryClient)]);

  const saveMutation = useMutation({
    mutationFn: savePricingOverride,
    onSuccess: applyRepricedOverrides,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: acknowledgeOfficialPricing,
    onSuccess: reloadOverrides,
  });

  const deleteMutation = useMutation({
    mutationFn: deletePricingOverride,
    onSuccess: applyRepricedOverrides,
  });

  const pendingModel = saveMutation.isPending
    ? saveMutation.variables.model
    : acknowledgeMutation.isPending
      ? acknowledgeMutation.variables
      : deleteMutation.isPending
        ? deleteMutation.variables
        : null;

  const unmatched: UnmatchedPricing = unmatchedQuery.data
    ? {
        status: "ready",
        models: unmatchedQuery.data.unmatchedModels,
        updatedAt: unmatchedQuery.dataUpdatedAt,
        refreshing: unmatchedQuery.isFetching,
      }
    : unmatchedQuery.isError
      ? { status: "error" }
      : { status: "pending" };

  return {
    overrides: overridesQuery.data?.overrides,
    overridesError: overridesQuery.isError && !overridesQuery.data,
    unmatched,
    retryOverrides: () => void overridesQuery.refetch(),
    retryUnmatched: () => void unmatchedQuery.refetch(),
    saveOverride: saveMutation.mutateAsync,
    acknowledgeOfficial: acknowledgeMutation.mutateAsync,
    deleteOverride: deleteMutation.mutateAsync,
    refreshModels: () => refreshMutation.mutate(),
    refreshStatus: refreshMutation.isSuccess
      ? refreshMutation.data.changed
        ? "changed"
        : "unchanged"
      : refreshMutation.status,
    historyPhase: history?.phase,
    isMutating: saveMutation.isPending || acknowledgeMutation.isPending || deleteMutation.isPending,
    pendingModel,
  };
}
