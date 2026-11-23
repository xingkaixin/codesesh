import type { AppConfig } from "@codesesh/contract";
import { t } from "../i18n/translate";
import { useQuery } from "@tanstack/react-query";
import { fetchConfig } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

let bootstrappedConfig: AppConfig | null | undefined;

function readBootstrappedConfig(): AppConfig | undefined {
  if (bootstrappedConfig !== undefined) return bootstrappedConfig ?? undefined;
  if (typeof document === "undefined") return undefined;
  const raw = document.querySelector('meta[name="codesesh-config"]')?.getAttribute("content");
  if (!raw) {
    bootstrappedConfig = null;
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as AppConfig;
    if (parsed && typeof parsed === "object" && "window" in parsed) {
      bootstrappedConfig = parsed;
      return parsed;
    }
  } catch {
    // Fall back to /api/config if the bootstrap meta tag is malformed.
  }
  bootstrappedConfig = null;
  return undefined;
}

export function useAppConfig() {
  const initialConfig = readBootstrappedConfig();
  const query = useQuery({
    queryKey: queryKeys.config,
    initialData: initialConfig,
    staleTime: initialConfig ? Infinity : 0,
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
      ? t("Failed to load configuration. The CLI may be restarting or unavailable.")
      : null,
    retry: query.refetch,
  };
}
