/**
 * Lifecycle owner for the background price refresh.
 *
 * The refresh used to be fired and forgotten: no timeout, no cancellation, and
 * it replaced the live prices the moment it returned — so one scan could price
 * its first sessions differently from its last. Here it is bounded, cancellable
 * on shutdown, and published only at a point where no scan is running.
 */
import { publishPendingPricing, refreshPricingCache } from "@codesesh/core/runtime";
import { appLogger } from "./logging.js";

/** Long enough for a cold network, short enough not to outlive a --json run. */
const REFRESH_TIMEOUT_MS = 10_000;

export interface PricingRefresh {
  /** Makes a completed refresh current. Safe to call more than once. */
  publish(): void;
  /** Cancels an in-flight refresh and waits for it to settle. */
  cancel(): Promise<void>;
}

export function startPricingRefresh(timeoutMs = REFRESH_TIMEOUT_MS): PricingRefresh {
  const controller = new AbortController();
  const completion = refreshPricingCache({ signal: controller.signal, timeoutMs }).catch(
    (error: unknown) => {
      appLogger.warn("pricing.refresh.error", { error });
      return false;
    },
  );

  return {
    publish() {
      if (publishPendingPricing()) appLogger.info("pricing.refresh.published", {});
    },
    async cancel() {
      controller.abort();
      await completion;
    },
  };
}
