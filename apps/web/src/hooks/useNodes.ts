import { useEffect, useState } from "react";
import type { SourceNode } from "../lib/api";
import { useQuery } from "@tanstack/react-query";
import { fetchConfig, fetchNodes } from "../lib/api";

export function useNodes() {
  const { data: config } = useQuery({
    queryKey: ["config"],
    queryFn: () => fetchConfig(),
    enabled: false,
  });
  return useQuery({
    queryKey: ["source-nodes"],
    queryFn: ({ signal }) => fetchNodes({ signal }),
    enabled: config?.hubEnabled === true,
    refetchInterval: 5000,
    retry: false,
  });
}

export function useNodeClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function isNodeOnline(node: SourceNode, now: number) {
  return !node.revoked && node.lastSeen != null && now - node.lastSeen <= 60000;
}
