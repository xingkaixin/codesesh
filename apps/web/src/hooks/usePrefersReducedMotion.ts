/** `prefers-reduced-motion`, as reactive state — the canvas charts fall back to
 *  a single static frame when it is set. */
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => globalThis.matchMedia?.(QUERY).matches ?? false);

  useEffect(() => {
    const media = globalThis.matchMedia?.(QUERY);
    if (!media) return;

    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return reduced;
}
