import { appendFile } from "node:fs/promises";
import { expect, test } from "./test-fixtures.js";

test("refreshes an open session when its source file changes", async ({ page }, testInfo) => {
  const fixtureSessionPath = testInfo.project.metadata.fixtureSessionPath;
  if (typeof fixtureSessionPath !== "string") {
    throw new Error("Missing staged session fixture path");
  }

  await page.goto("/claudecode/e2e-dashboard");
  await expect(page.getByTestId("session-detail")).toBeVisible();
  await expect(page.getByText("Dashboard path is ready")).toBeVisible();

  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });

  const searchNeedle = `liveindexneedle${testInfo.retry}`;
  const liveMessage = `Live refresh reached the browser on attempt ${testInfo.retry}: ${searchNeedle}.`;
  const record = {
    type: "assistant",
    uuid: `assistant-live-${testInfo.retry}`,
    timestamp: "2026-04-20T10:00:03Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 12,
      },
      content: [{ type: "text", text: liveMessage }],
    },
  };

  await appendFile(fixtureSessionPath, `${JSON.stringify(record)}\n`, "utf8");

  await expect(page.getByText(liveMessage)).toBeVisible();
  const searchResponse = await page.request.get(`/api/search?q=${searchNeedle}`);
  expect(searchResponse.ok()).toBe(true);
  const searchBody = (await searchResponse.json()) as {
    results?: Array<{ session?: { reference?: { sessionId?: string } } }>;
  };
  expect(
    searchBody.results?.some((result) => result.session?.reference?.sessionId === "e2e-dashboard"),
  ).toBe(true);
  expect(mainFrameNavigations).toBe(0);
});
