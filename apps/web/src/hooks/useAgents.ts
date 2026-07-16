import { useCallback, useMemo, useState } from "react";
import { type AgentInfo, type AppConfig, type FetchOptions, fetchAgents } from "../lib/api";

/**
 * Owns the agent list and its lookup derivations. Refresh is driven by
 * useWindowedDataLoad / useLiveSync (shared startup loading gate).
 */
export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const validAgentKeys = useMemo(() => new Set(agents.map((a) => a.name.toLowerCase())), [agents]);
  const agentNameMap = useMemo(
    () => new Map(agents.map((agent) => [agent.name.toLowerCase(), agent.displayName])),
    [agents],
  );

  const refresh = useCallback(async (window?: AppConfig["window"], options?: FetchOptions) => {
    const list = await fetchAgents(window, options);
    setAgents(list);
    return list;
  }, []);

  return { agents, validAgentKeys, agentNameMap, refresh };
}
