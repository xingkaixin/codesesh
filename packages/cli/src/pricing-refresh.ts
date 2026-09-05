import { publishPendingPricing, refreshPricingCache } from "@codesesh/core/runtime/pricing";
import { appLogger } from "./logging.js";

/** Long enough for a cold network, short enough not to outlive a --json run. */
const REFRESH_TIMEOUT_MS = 10_000;

export interface PricingRefresh {
  /** Waits for the bounded refresh and publishes prices before scanning. */
  ready(): Promise<void>;
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
    async ready() {
      await completion;
      if (publishPendingPricing()) appLogger.info("pricing.refresh.published", {});
    },
    async cancel() {
      controller.abort();
      await completion;
    },
  };
}
