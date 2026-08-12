import { appendFile } from "node:fs/promises";
import { expect, test } from "./test-fixtures.js";

const REMOTE_HOST = "tracker.invalid";

/**
 * CodeSesh renders transcripts an agent produced, so a remote URL inside one is
 * untrusted. Loading it would hand a third party the reader's IP and the time
 * they opened the session.
 */
test("never requests remote media referenced by a transcript", async ({ page }, testInfo) => {
  const fixtureSessionPath = testInfo.project.metadata.fixtureSessionPath;
  if (typeof fixtureSessionPath !== "string") {
    throw new Error("Missing staged session fixture path");
  }

  const marker = `localmedia${testInfo.retry}`;
  const record = {
    type: "assistant",
    uuid: `assistant-media-${testInfo.retry}`,
    timestamp: "2026-04-20T10:00:04Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 12,
      },
      content: [
        {
          type: "text",
          text: [
            `Report ${marker}`,
            `![screenshot](https://${REMOTE_HOST}/pixel.png)`,
            `![protocol relative](//${REMOTE_HOST}/beacon.png)`,
            `[link](https://${REMOTE_HOST}/page)`,
          ].join("\n\n"),
        },
        {
          type: "image",
          source: { type: "url", url: `https://${REMOTE_HOST}/tool-output.png` },
        },
      ],
    },
  };

  const offOrigin: string[] = [];
  await page.route("**/*", async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      await route.continue();
      return;
    }
    offOrigin.push(route.request().url());
    await route.abort();
  });

  await appendFile(fixtureSessionPath, `${JSON.stringify(record)}\n`, "utf8");

  await page.goto("/claudecode/e2e-dashboard");
  await expect(page.getByTestId("session-detail")).toBeVisible();
  await expect(page.getByText(`Report ${marker}`)).toBeVisible();
  await expect(page.getByText("Remote image not loaded").first()).toBeVisible();

  expect(offOrigin).toEqual([]);
  expect(await page.locator(`img[src*="${REMOTE_HOST}"]`).count()).toBe(0);
  expect(await page.locator(`link[href*="${REMOTE_HOST}"]`).count()).toBe(0);
});
