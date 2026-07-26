import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { deleteSessionAlias, upsertSessionAlias } from "../lib/api";
import { invalidateSessionDerivedQueries } from "../lib/session-query-consistency";

export interface SessionAliasIdentity {
  agentKey: string;
  sessionId: string;
}

interface SaveAliasVariables extends SessionAliasIdentity {
  alias: string;
}

export function useSessionAliasMutations(refreshSessionSnapshot: () => Promise<void>) {
  const queryClient = useQueryClient();

  const refreshAliasConsumers = useCallback(async () => {
    await Promise.all([refreshSessionSnapshot(), invalidateSessionDerivedQueries(queryClient)]);
  }, [queryClient, refreshSessionSnapshot]);

  const { mutateAsync: mutateAlias } = useMutation({
    mutationFn: ({ agentKey, sessionId, alias }: SaveAliasVariables) =>
      upsertSessionAlias(agentKey, sessionId, alias),
    onSuccess: refreshAliasConsumers,
  });
  const { mutateAsync: mutateAliasRemoval } = useMutation({
    mutationFn: ({ agentKey, sessionId }: SessionAliasIdentity) =>
      deleteSessionAlias(agentKey, sessionId),
    onSuccess: refreshAliasConsumers,
  });

  const saveAlias = useCallback(
    async (target: SessionAliasIdentity, alias: string) => {
      await mutateAlias({ ...target, alias });
    },
    [mutateAlias],
  );

  const removeAlias = useCallback(
    async (target: SessionAliasIdentity) => {
      await mutateAliasRemoval(target);
    },
    [mutateAliasRemoval],
  );

  return { saveAlias, removeAlias };
}
