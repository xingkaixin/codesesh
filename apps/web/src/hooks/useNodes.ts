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
