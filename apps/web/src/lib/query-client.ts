import { QueryClient } from "@tanstack/react-query";
import { installSessionDetailCachePolicy } from "./session-detail-cache";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createQueryClient();
installSessionDetailCachePolicy(queryClient);
