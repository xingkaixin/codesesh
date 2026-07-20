import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { createQueryClient } from "../lib/query-client";

export function createQueryWrapper(): {
  client: QueryClient;
  Wrapper: ({ children }: PropsWithChildren) => React.JSX.Element;
} {
  const client = createQueryClient();
  return {
    client,
    Wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
