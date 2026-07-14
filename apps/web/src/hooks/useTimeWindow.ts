import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  resolveTimeWindow,
  writeCustomTimeWindow,
  writeTimeWindowPreset,
  type TimeWindow,
  type TimeWindowPreset,
} from "../lib/time-window";

export function useTimeWindow(defaultWindow: TimeWindow | undefined) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  const hasRange = searchParams.has("range");
  const previousPath = useRef(location.pathname);
  const rememberedRange = useRef<string | null>(null);
  if (hasRange) {
    const rangeParams = new URLSearchParams();
    for (const key of ["range", "from", "to"]) {
      const value = searchParams.get(key);
      if (value != null) rangeParams.set(key, value);
    }
    rememberedRange.current = rangeParams.toString();
  }
  const pathChanged = previousPath.current !== location.pathname;
  const effectiveSearch = useMemo(() => {
    if (hasRange || !pathChanged || !rememberedRange.current) {
      return search;
    }
    const next = new URLSearchParams(search);
    const remembered = new URLSearchParams(rememberedRange.current);
    for (const [key, value] of remembered) {
      next.set(key, value);
    }
    return next.toString();
  }, [hasRange, pathChanged, search]);
  const effectiveParams = useMemo(() => new URLSearchParams(effectiveSearch), [effectiveSearch]);

  useEffect(() => {
    previousPath.current = location.pathname;
    if (effectiveSearch !== search) setSearchParams(effectiveParams, { replace: true });
  }, [effectiveParams, effectiveSearch, location.pathname, search, setSearchParams]);

  const resolved = useMemo(
    () => (defaultWindow ? resolveTimeWindow(effectiveParams, defaultWindow) : null),
    [defaultWindow, effectiveParams],
  );
  const resolve = useCallback(
    (fallback: TimeWindow) => resolveTimeWindow(effectiveParams, fallback).window,
    [effectiveParams],
  );
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
    selectPreset,
    selectCustom,
  };
}
