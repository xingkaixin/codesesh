import { useCallback } from "react";
import { attachFluidHover } from "../../../shared/fluid-hover";

export function useFluidHover<T extends HTMLElement>() {
  return useCallback((element: T | null) => {
    if (element) return attachFluidHover(element);
  }, []);
}
