import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  resolveTimeWindow,
  writeCustomTimeWindow,
  writeTimeWindowPreset,
  type TimeWindow,
  type TimeWindowPreset,
} from "../lib/time-window";

const TIME_WINDOW_PARAM_KEYS = ["range", "from", "to"] as const;

function selectedTimeWindowSearch(params: URLSearchParams): string {
  const selectedParams = new URLSearchParams();
  for (const key of TIME_WINDOW_PARAM_KEYS) {
    const value = params.get(key);
    if (value != null) selectedParams.set(key, value);
  }
  return selectedParams.toString();
}

function nextLocalMidnight(now = Date.now()): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function currentLocalDayEnd(nextRefreshAt: number, now = Date.now()): number {
  return (nextRefreshAt > now ? nextRefreshAt : nextLocalMidnight(now)) - 1;
}

function isRollingPreset(preset: TimeWindowPreset | null): boolean {
  return preset !== null && preset !== "all" && preset !== "custom";
}

export function useTimeWindow(defaultWindow: TimeWindow | undefined) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  const hasRange = searchParams.has("range");
  const selectedRangeSearch = hasRange ? selectedTimeWindowSearch(searchParams) : null;
  const [selectionMemory, setSelectionMemory] = useState(() => ({
    pathname: location.pathname,
    rangeSearch: selectedRangeSearch,
  }));
  const [nextPresetRefreshAt, setNextPresetRefreshAt] = useState(nextLocalMidnight);
  const pathChanged = selectionMemory.pathname !== location.pathname;
  if (
    selectedRangeSearch !== null &&
    (pathChanged || selectionMemory.rangeSearch !== selectedRangeSearch)
  ) {
    setSelectionMemory({ pathname: location.pathname, rangeSearch: selectedRangeSearch });
  }
  const effectiveSearch = useMemo(() => {
    if (hasRange || !pathChanged || !selectionMemory.rangeSearch) {
      return search;
    }
    const next = new URLSearchParams(search);
    const remembered = new URLSearchParams(selectionMemory.rangeSearch);
    for (const [key, value] of remembered) {
      next.set(key, value);
    }
    return next.toString();
  }, [hasRange, pathChanged, search, selectionMemory.rangeSearch]);
  const effectiveParams = useMemo(() => new URLSearchParams(effectiveSearch), [effectiveSearch]);
  const selectedWindowSearch = selectedTimeWindowSearch(effectiveParams);
  const selectedWindowParams = useMemo(
    () => new URLSearchParams(selectedWindowSearch),
    [selectedWindowSearch],
  );

  useEffect(() => {
    if (effectiveSearch !== search) {
      setSearchParams(effectiveParams, { replace: true });
    }
  }, [effectiveParams, effectiveSearch, search, setSearchParams]);

  const resolved = useMemo(
    () =>
      defaultWindow
        ? resolveTimeWindow(
            selectedWindowParams,
            defaultWindow,
            currentLocalDayEnd(nextPresetRefreshAt),
          )
        : null,
    [defaultWindow, nextPresetRefreshAt, selectedWindowParams],
  );
  const resolve = useCallback(
    (fallback: TimeWindow) => resolveTimeWindow(selectedWindowParams, fallback).window,
    [selectedWindowParams],
  );
  const resolveCurrent = useCallback(
    () => (defaultWindow ? resolve(defaultWindow) : null),
    [defaultWindow, resolve],
  );

  useEffect(() => {
    if (!isRollingPreset(resolved?.preset ?? null)) return;

    const delay = Math.max(0, nextPresetRefreshAt - Date.now());
    const timer = window.setTimeout(() => {
      setNextPresetRefreshAt(nextLocalMidnight());
    }, delay);

    return () => window.clearTimeout(timer);
  }, [nextPresetRefreshAt, resolved?.preset]);
  const selectPreset = useCallback(
    (preset: TimeWindowPreset) =>
      setSearchParams(writeTimeWindowPreset(new URLSearchParams(search), preset)),
    [search, setSearchParams],
  );
  const selectCustom = useCallback(
    (from: string, to: string) =>
      setSearchParams(writeCustomTimeWindow(new URLSearchParams(search), from, to)),
    [search, setSearchParams],
  );

  return {
    timeWindow: resolved?.window ?? null,
    preset: resolved?.preset ?? null,
    customFrom: resolved?.customFrom,
    customTo: resolved?.customTo,
    resolve,
    resolveCurrent,
    selectPreset,
    selectCustom,
  };
}
