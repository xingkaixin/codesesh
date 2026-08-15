import { expect, test as base } from "playwright/test";
import { monitorBrowserErrors } from "./test-fixtures.js";

// Network failures unavoidably log resource/console errors; those are the
// scenario, not a defect. Anything else — above all an "Uncaught (in
// promise)" from the retry handler — must stay absent.
const EXPECTED_NETWORK_NOISE =
  /Failed to load resource|net::ERR|Failed to fetch|NetworkError|Failed to load config/i;

// Uses the raw playwright test: the shared browserErrorGate fixture asserts a
// fully clean console, which a deliberately failing API cannot satisfy.
base("keeps the retry surface clean while the API is down", async ({ page }) => {
  // The failing branch waits out react-query's retry backoff before the error
  // surface appears; CI runners need more than the default 30s budget.
  base.setTimeout(120_000);
  const errors = monitorBrowserErrors(page);
  let failing = true;
  await page.route("**/api/config**", (route) =>
    failing ? route.abort("connectionrefused") : route.continue(),
  );

  await page.goto("/");
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible({ timeout: 30_000 });

  // Retry while the server is still down: the error surface must persist and
  // the click must not leak an unhandled rejection. dispatchEvent instead of
  // click: background query retries keep re-rendering the panel, so a real
  // click never sees a stable target on slow runners.
  await retry.dispatchEvent("click");
  await expect(retry).toBeVisible();

  // Once the API is back, the retry button must bring the dashboard back.
  failing = false;
  await retry.dispatchEvent("click");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 60_000 });

  const unexpected = errors.filter((entry) => !EXPECTED_NETWORK_NOISE.test(entry));
  expect(unexpected, "unexpected browser errors").toEqual([]);
});
