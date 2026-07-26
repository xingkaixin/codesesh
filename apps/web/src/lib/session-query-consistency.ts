import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";

export async function invalidateSessionDerivedQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionSnapshotAggregateQueries }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessionDetails }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboards }),
    queryClient.invalidateQueries({ queryKey: queryKeys.searches }),
  ]);
}
