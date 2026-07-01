import { useCallback, useMemo, useState } from "react";
import { type AgentInfo, fetchAgents } from "../lib/api";

/**
 * Owns the agent list and its lookup derivations. Refresh is driven by
 * useInitialLoad / useLiveSync (shared startup loading gate).
 */
export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const validAgentKeys = useMemo(() => new Set(agents.map((a) => a.name.toLowerCase())), [agents]);
  const agentNameMap = useMemo(
    () => new Map(agents.map((agent) => [agent.name.toLowerCase(), agent.displayName])),
    [agents],
  );

  const refresh = useCallback(async () => {
    const list = await fetchAgents();
    setAgents(list);
    return list;
  }, []);

  return { agents, validAgentKeys, agentNameMap, refresh };
}
