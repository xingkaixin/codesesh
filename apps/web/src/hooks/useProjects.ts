import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiProjectGroup, ApiProjectPage, AppConfig } from "../lib/api";
import { ApiRequestError, fetchProject, fetchProjects } from "../lib/api";
import { getProjectIdentityKey, type ProjectRouteIdentity } from "../lib/projects";
import { queryKeys } from "../lib/query-keys";

const PROJECT_QUERY_STALE_TIME_MS = 2_000;
const EMPTY_CURSORS: string[] = [];

function windowKey(window: AppConfig["window"] | null): string {
  if (!window) return "unavailable";
  return `${window.days ?? ""}:${window.from ?? ""}:${window.to ?? ""}`;
}

export function useProjectPagination(
  window: AppConfig["window"] | null,
  initialPage: ApiProjectPage,
) {
  const key = windowKey(window);
  const [navigation, setNavigation] = useState<{ key: string; cursors: string[] }>({
    key,
    cursors: [],
  });
  const cursors = navigation.key === key ? navigation.cursors : EMPTY_CURSORS;
  const cursor = cursors.at(-1);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.projectPage(window ?? {}, cursor),
    queryFn: ({ signal }) => fetchProjects(window ?? undefined, { cursor, signal }),
    enabled: window != null,
    initialData: cursor ? undefined : initialPage,
    placeholderData: cursor ? keepPreviousData : undefined,
    staleTime: PROJECT_QUERY_STALE_TIME_MS,
    retry: false,
  });
  const page = query.data ?? (cursor ? null : initialPage);
  const staleCursor =
    Boolean(cursor) && query.error instanceof ApiRequestError && query.error.status === 409;

  useEffect(() => {
    if (!staleCursor) return;
    void queryClient
      .invalidateQueries(
        { queryKey: queryKeys.projectPage(window ?? {}), exact: true },
        { cancelRefetch: true },
      )
      .then(() => setNavigation({ key, cursors: [] }));
  }, [key, queryClient, staleCursor, window]);

  const next = useCallback(() => {
    const nextCursor = query.data?.nextCursor;
    if (!nextCursor || query.isPlaceholderData) return;
    setNavigation({ key, cursors: [...cursors, nextCursor] });
  }, [cursors, key, query.data?.nextCursor, query.isPlaceholderData]);

  const previous = useCallback(() => {
    setNavigation({ key, cursors: cursors.slice(0, -1) });
  }, [cursors, key]);

  const retry = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    page,
    pageNumber: cursors.length + 1,
    loading: staleCursor || query.isPending || query.isPlaceholderData,
    error: staleCursor
      ? null
      : query.isError && query.error instanceof Error
        ? query.error.message
        : query.isError
          ? "Unable to load projects."
          : null,
    canPrevious: cursors.length > 0 && !staleCursor && !query.isPlaceholderData,
    canNext: Boolean(query.data?.nextCursor) && !staleCursor && !query.isPlaceholderData,
    next,
    previous,
    retry,
  };
}

export function useProjectLookup(
  window: AppConfig["window"] | null,
  identity: ProjectRouteIdentity | null,
  projects: ApiProjectGroup[],
) {
  const identityKey = identity ? getProjectIdentityKey(identity) : null;
  const localProject = useMemo(
    () =>
      identityKey
        ? (projects.find(
            (project) =>
              getProjectIdentityKey({ kind: project.identityKind, key: project.identityKey }) ===
              identityKey,
          ) ?? null)
        : null,
    [identityKey, projects],
  );
  const query = useQuery({
    queryKey: queryKeys.projectDetail(window ?? {}, identity ?? { kind: "path", key: "" }),
    queryFn: ({ signal }) => fetchProject(window!, identity!, { signal }),
    enabled: window != null && identity != null && localProject == null,
    staleTime: PROJECT_QUERY_STALE_TIME_MS,
    retry: false,
  });

  return {
    project: localProject ?? query.data ?? null,
    loading: query.isPending && window != null && identity != null && localProject == null,
    error:
      query.isError && query.error instanceof Error
        ? query.error.message
        : query.isError
          ? "Unable to load project."
          : null,
    retry: query.refetch,
  };
}
