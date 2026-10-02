import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "./test-fixtures.js";

test("pages a long session, completes its receipt and loads a distant search match", async ({
  page,
}, testInfo) => {
  const original = testInfo.project.metadata.fixtureSessionPath;
  if (typeof original !== "string") throw new Error("Missing session fixture path");
  const first = JSON.parse((await readFile(original, "utf8")).split("\n")[0]!) as { cwd: string };
  const fixture = join(dirname(original), "e2e-paged.jsonl");
  const records = Array.from({ length: 450 }, (_, index) =>
    JSON.stringify({
      type: "user",
      uuid: `page-${index}`,
      timestamp: new Date(Date.UTC(2026, 3, 20, 11, 0, index)).toISOString(),
      cwd: first.cwd,
      message: {
        role: "user",
        content:
          index === 420
            ? "Distant search match at message 420"
            : `Paged conversation message ${index}`,
      },
    }),
  );
  await writeFile(fixture, `${records.join("\n")}\n`);
  try {
    await expect
      .poll(async () => {
        const response = await page.request.get(
          "/api/sessions/claudecode/e2e-paged?messageLimit=200",
        );
        if (!response.ok()) return 0;
        const data = (await response.json()) as { message_total: number; messages: unknown[] };
        expect(data.messages.length).toBeLessThanOrEqual(200);
        return data.message_total;
      })
      .toBe(450);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/claudecode/e2e-paged");
    await expect(page.getByText("Loaded 200 of 450 messages")).toBeVisible();
    await expect(page.getByText("Loaded 200 of 450 messages")).toBeInViewport();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Load more messages" }).click();
    await expect(page.getByText("Loaded 400 of 450 messages")).toBeVisible();
    await page.getByRole("button", { name: "Open session receipt" }).click();
    const receipt = page.getByRole("dialog", { name: "Session Receipt" });
    await expect(
      receipt.locator("dl > div").filter({ hasText: "User messages" }).locator("dd"),
    ).toHaveText("450");
    await page.keyboard.press("Escape");
    await page.goto("/claudecode/e2e-paged#message-420");
    await expect(page.getByText("Distant search match at message 420")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Load more messages" })).toHaveCount(0);
  } finally {
    await rm(fixture, { force: true });
  }
});
