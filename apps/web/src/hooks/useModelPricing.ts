import type {
  AppConfig,
  PricingMutationResponse,
  PricingOverviewResponse,
  UpsertPricingOverrideRequest,
} from "@codesesh/contract";
import {
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  acknowledgeOfficialPricing,
  deletePricingOverride,
  fetchPricingOverview,
  savePricingOverride,
} from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { useScanStatus } from "./useScanStatus";

export interface ModelPricingState {
  overview: PricingOverviewResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  saveOverride: (request: UpsertPricingOverrideRequest) => Promise<PricingMutationResponse>;
  acknowledgeOfficial: (model: string) => Promise<PricingOverviewResponse>;
  deleteOverride: (model: string) => Promise<PricingMutationResponse>;
  isMutating: boolean;
  pendingModel: string | null;
}

async function syncOverviewCache(
  queryClient: QueryClient,
  activeKey: readonly unknown[],
  overview: PricingOverviewResponse,
): Promise<void> {
  queryClient.setQueryData(activeKey, overview);
  const activeHash = hashKey(activeKey);
  await queryClient.invalidateQueries({
    queryKey: queryKeys.pricingOverviews,
    refetchType: "none",
    predicate: (query) => query.queryHash !== activeHash,
  });
}

async function invalidateRepricedQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboards }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionProjections }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionDetails }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
    queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agentCatalogs }),
  ]);
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
  const overviewKey = queryKeys.pricingOverview(from, to, days);

  const overviewQuery = useQuery<PricingOverviewResponse>({
    queryKey: overviewKey,
    queryFn: () => fetchPricingOverview(from, to, days),
    enabled: active,
    staleTime: 60_000,
  });

  const scanActive = Boolean(scanStatus?.active || scanStatus?.backfill.active);
  const wasScanActiveRef = useRef(scanActive);

  useEffect(() => {
    const wasActive = wasScanActiveRef.current;
    wasScanActiveRef.current = scanActive;
    if (active && wasActive && !scanActive) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pricingOverviews });
    }
  }, [active, queryClient, scanActive]);

  const saveMutation = useMutation({
    mutationFn: (request: UpsertPricingOverrideRequest) =>
      savePricingOverride(request, from, to, days),
    onSuccess: async (response) => {
      await Promise.all([
        syncOverviewCache(queryClient, overviewKey, response.overview),
        invalidateRepricedQueries(queryClient),
      ]);
    },
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (model: string) => acknowledgeOfficialPricing(model, from, to, days),
    onSuccess: async (overview) => {
      await syncOverviewCache(queryClient, overviewKey, overview);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (model: string) => deletePricingOverride(model, from, to, days),
    onSuccess: async (response) => {
      await Promise.all([
        syncOverviewCache(queryClient, overviewKey, response.overview),
        invalidateRepricedQueries(queryClient),
      ]);
    },
  });

  const pendingModel = saveMutation.isPending
    ? saveMutation.variables.model
    : acknowledgeMutation.isPending
      ? acknowledgeMutation.variables
      : deleteMutation.isPending
        ? deleteMutation.variables
        : null;

  return {
    overview: overviewQuery.data,
    isLoading: overviewQuery.isLoading,
    isError: overviewQuery.isError,
    error: overviewQuery.error,
    refetch: async () => {
      await overviewQuery.refetch();
    },
    saveOverride: saveMutation.mutateAsync,
    acknowledgeOfficial: acknowledgeMutation.mutateAsync,
    deleteOverride: deleteMutation.mutateAsync,
    isMutating: saveMutation.isPending || acknowledgeMutation.isPending || deleteMutation.isPending,
    pendingModel,
  };
}
