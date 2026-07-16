import { useCallback, useState } from "react";
import { type AppConfig, type FetchOptions, fetchConfig } from "../lib/api";

/**
 * Owns app config (the shared time window etc). Not auto-fetching: useWindowedDataLoad
 * drives the initial refresh so the whole startup shares one loading/error gate.
 */
export function useAppConfig() {
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);

  const refresh = useCallback(async (options?: FetchOptions) => {
    const config = await fetchConfig(options);
    setAppConfig(config);
    return config;
  }, []);

  return { appConfig, refresh };
}
