import { t } from "../i18n/translate";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiProjectGroup, ApiProjectPage, AppConfig } from "@codesesh/contract";
import { ApiRequestError, fetchProject, fetchProjects, type ProjectSort } from "../lib/api";
import { getProjectIdentityKey, type ProjectRouteIdentity } from "../lib/projects";
import { queryKeys } from "../lib/query-keys";

const PROJECT_QUERY_STALE_TIME_MS = 2_000;
const EMPTY_CURSORS: string[] = [];

export interface ProjectPaginationControl {
  cursor?: string;
  pageNumber?: number;
  onNavigate: (
    next: { cursor?: string; pageNumber: number },
    options?: { replace?: boolean },
  ) => void;
}

interface PageBackEntry {
  cursor?: string;
  pageNumber: number;
}

function windowKey(window: AppConfig["window"] | null): string {
  if (!window) return "unavailable";
  return `${window.days ?? ""}:${window.from ?? ""}:${window.to ?? ""}`;
}

export function useProjectPagination(
  window: AppConfig["window"] | null,
  initialPage: ApiProjectPage,
  sourceNodeId?: string,
  sort: ProjectSort = "latest",
  control?: ProjectPaginationControl,
) {
  const key = `${windowKey(window)}:${sourceNodeId ?? ""}:${sort}`;
  const [navigation, setNavigation] = useState<{ key: string; cursors: string[] }>({
    key,
    cursors: [],
  });
  const [backStack, setBackStack] = useState<{ key: string; entries: PageBackEntry[] }>({
    key,
    entries: [],
  });
  const cursors = navigation.key === key ? navigation.cursors : EMPTY_CURSORS;
  const cursor = control ? control.cursor : cursors.at(-1);
  const pageNumber = control
    ? cursor
      ? Math.max(2, control.pageNumber ?? 2)
      : 1
    : cursors.length + 1;
  const isDefaultFirstPage = !cursor && !sourceNodeId && sort === "latest";
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.projectPage(window ?? {}, cursor, sourceNodeId, sort),
    queryFn: ({ signal }) =>
      fetchProjects(window ?? undefined, { cursor, signal, sourceNodeId, sort }),
    enabled: window != null,
    initialData: isDefaultFirstPage ? initialPage : undefined,
    placeholderData: isDefaultFirstPage ? undefined : keepPreviousData,
    staleTime: PROJECT_QUERY_STALE_TIME_MS,
    retry: false,
  });
  const page = query.data ?? (isDefaultFirstPage ? initialPage : null);
  const staleCursor =
    Boolean(cursor) &&
    query.error instanceof ApiRequestError &&
    (query.error.status === 409 || query.error.status === 400);
  const onNavigate = control?.onNavigate;

  useEffect(() => {
    if (!staleCursor) return;
    let cancelled = false;
    void queryClient
      .invalidateQueries(
        {
          queryKey: queryKeys.projectPage(window ?? {}, undefined, sourceNodeId, sort),
          exact: true,
        },
        { cancelRefetch: true },
      )
      .then(() => {
        if (cancelled) return;
        if (onNavigate) {
          setBackStack({ key, entries: [] });
          onNavigate({ cursor: undefined, pageNumber: 1 }, { replace: true });
        } else {
          setNavigation((current) =>
            current.key === key && current.cursors.at(-1) === cursor
              ? { key, cursors: [] }
              : current,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cursor, key, onNavigate, queryClient, sort, sourceNodeId, staleCursor, window]);

  const next = useCallback(() => {
    const nextCursor = query.data?.nextCursor;
    if (!nextCursor || query.isPlaceholderData) return;
    if (onNavigate) {
      setBackStack((current) => ({
        key,
        entries: [...(current.key === key ? current.entries : []), { cursor, pageNumber }],
      }));
      onNavigate({ cursor: nextCursor, pageNumber: pageNumber + 1 });
    } else {
      setNavigation({ key, cursors: [...cursors, nextCursor] });
    }
  }, [
    cursor,
    cursors,
    key,
    onNavigate,
    pageNumber,
    query.data?.nextCursor,
    query.isPlaceholderData,
  ]);

  const previous = useCallback(() => {
    if (onNavigate) {
      const entries = backStack.key === key ? backStack.entries : [];
      const target = entries.at(-1) ?? { cursor: undefined, pageNumber: 1 };
      setBackStack({ key, entries: entries.slice(0, -1) });
      onNavigate(target);
    } else {
      setNavigation({ key, cursors: cursors.slice(0, -1) });
    }
  }, [backStack, cursors, key, onNavigate]);

  const retry = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    page,
    pageNumber,
    loading: staleCursor || query.isPending || query.isPlaceholderData,
    error: staleCursor
      ? null
      : query.isError && query.error instanceof Error
        ? query.error.message
        : query.isError
          ? t("Unable to load projects.")
          : null,
    canPrevious: pageNumber > 1 && !staleCursor && !query.isPlaceholderData,
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
          ? t("Unable to load project.")
          : null,
    retry: query.refetch,
  };
}
