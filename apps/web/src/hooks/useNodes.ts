import { useEffect, useState } from "react";
import type { SourceNode } from "@codesesh/contract";
import { useQuery } from "@tanstack/react-query";
import { fetchConfig, fetchNodes } from "../lib/api";

function useHubEnabled(): boolean {
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => fetchConfig(),
    enabled: false,
  });
  return config?.hubEnabled === true;
}

export function useNodes(enabled = true) {
  const hubEnabled = useHubEnabled();
  return useQuery({
    queryKey: ["source-nodes"],
    queryFn: ({ signal }) => fetchNodes({ signal }),
    enabled: enabled && hubEnabled,
    staleTime: 4000,
    refetchInterval: 5000,
    retry: false,
  });
}

export function useNodeClock(enabled = true) {
  const hubEnabled = useHubEnabled();
  const active = enabled && hubEnabled;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function isNodeOnline(node: SourceNode, now: number) {
  return !node.revoked && node.lastSeen != null && now - node.lastSeen <= 60000;
}
