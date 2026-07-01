import { useCallback, useState } from "react";
import { type AppConfig, fetchConfig } from "../lib/api";

/**
 * Owns app config (the shared time window etc). Not auto-fetching: useInitialLoad
 * drives the initial refresh so the whole startup shares one loading/error gate.
 */
export function useAppConfig() {
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);

  const refresh = useCallback(async () => {
    const config = await fetchConfig();
    setAppConfig(config);
    return config;
  }, []);

  return { appConfig, refresh };
}
