import { useCallback } from "react";
import { attachFluidHover } from "../lib/fluid-hover";

export function useFluidHover<T extends HTMLElement>() {
  return useCallback((element: T | null) => {
    if (element) return attachFluidHover(element);
  }, []);
}
