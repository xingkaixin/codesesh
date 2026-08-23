import { useQuery } from "@tanstack/react-query";
import { fetchConfig } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

export function useAppConfig() {
  const query = useQuery({
    queryKey: queryKeys.config,
    retry: 2,
    retryDelay: 250,
    queryFn: async ({ signal }) => {
      try {
        return await fetchConfig({ signal });
      } catch (error) {
        if (!signal.aborted) console.error("Failed to load config:", error);
        throw error;
      }
    },
  });

  return {
    config: query.data ?? null,
    loading: query.isPending,
    error: query.isError
      ? "Failed to load configuration. The CLI may be restarting or unavailable."
      : null,
    retry: query.refetch,
  };
}
