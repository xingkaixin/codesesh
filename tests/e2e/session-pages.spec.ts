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
    await expect(page.getByText("Loaded 200 of 450 messages").first()).toBeVisible();
    await expect(page.getByText("Loaded 200 of 450 messages").first()).toBeInViewport();
    await page.setViewportSize({ width: 1280, height: 720 });
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    await page.route("**/api/sessions/claudecode/e2e-paged?*", async (route) => {
      if (new URL(route.request().url()).searchParams.has("messageCursor")) await pageGate;
      await route.continue();
    });
    const continuation = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith("/e2e-paged") && url.searchParams.has("messageCursor");
    });
    const footer = page.getByTestId("session-message-paging-footer");
    await expect(footer.getByRole("button", { name: "Load more messages" })).toBeAttached();
    await footer.scrollIntoViewIfNeeded();
    await continuation;
    await page.getByText("Paged conversation message 199", { exact: true }).click({ trial: true });
    const anchor = await page.locator("[data-message-id]").evaluateAll((rows) => {
      const row = rows.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 150 && rect.bottom <= window.innerHeight;
      });
      if (!row) throw new Error("No visible message before pagination");
      return { id: row.getAttribute("data-message-id"), top: row.getBoundingClientRect().top };
    });
    releasePage();
    await expect(page.getByText("Loaded 400 of 450 messages").first()).toBeAttached();
    await expect
      .poll(async () =>
        page
          .locator(`[data-message-id="${anchor.id}"]`)
          .evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeCloseTo(anchor.top, 0);
    await page.getByRole("button", { name: "Open session receipt" }).click();
    const receipt = page.getByRole("dialog", { name: "Session Receipt" });
    await expect(
      receipt.locator("dl > div").filter({ hasText: "User messages" }).locator("dd"),
    ).toHaveText("450");
    await page.keyboard.press("Escape");
    await page.goto("/claudecode/e2e-paged#message-420");
    await expect(page.getByText("Distant search match at message 420")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Load more messages" })).toHaveCount(0);
    await page.goto("/claudecode/e2e-paged");
    await expect(page.getByText("Loaded 200 of 450 messages").first()).toBeVisible();
    await footer.scrollIntoViewIfNeeded();
    await expect(page.getByText("Loaded 400 of 450 messages").first()).toBeAttached();
    await expect(
      page.getByText("Paged conversation message 199", { exact: true }),
    ).toBeInViewport();
    await page.goto("/claudecode/e2e-paged");
    await expect(page.getByRole("button", { name: "Load all messages" })).toHaveCount(1);
    await expect(footer.getByRole("button", { name: "Load all messages" })).toHaveCount(0);
    await page.getByRole("button", { name: "Load all messages" }).click();
    await expect(page.getByRole("button", { name: /Load(ing)? (all|more) messages/ })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Open session receipt" }).click();
    await expect(
      receipt.locator("dl > div").filter({ hasText: "User messages" }).locator("dd"),
    ).toHaveText("450");
  } finally {
    await rm(fixture, { force: true });
  }
});

test("loads a final reply after a large tool output without opening the receipt", async ({
  page,
}, testInfo) => {
  const original = testInfo.project.metadata.fixtureSessionPath;
  if (typeof original !== "string") throw new Error("Missing session fixture path");
  const first = JSON.parse((await readFile(original, "utf8")).split("\n")[0]!) as { cwd: string };
  const fixture = join(dirname(original), "e2e-large-output.jsonl");
  const finalReply = "Final answer after the large tool output";
  const records = [
    {
      type: "user",
      uuid: "question",
      message: { role: "user", content: "Inspect the large output" },
    },
    {
      type: "assistant",
      uuid: "tool-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "large-tool",
            name: "Bash",
            input: { command: "cat large-output.txt" },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "tool-result",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "large-tool",
            content: "output line\n".repeat(60000),
          },
        ],
      },
    },
    {
      type: "assistant",
      uuid: "final-reply",
      message: { role: "assistant", content: [{ type: "text", text: finalReply }] },
    },
  ];
  await writeFile(
    fixture,
    `${records
      .map((record, index) =>
        JSON.stringify({
          ...record,
          cwd: first.cwd,
          timestamp: new Date(Date.UTC(2026, 3, 20, 12, 0, index)).toISOString(),
        }),
      )
      .join("\n")}\n`,
  );
  try {
    await expect
      .poll(async () => {
        const response = await page.request.get(
          "/api/sessions/claudecode/e2e-large-output?messageLimit=200",
        );
        if (!response.ok()) return false;
        const detail = (await response.json()) as { messages: unknown[]; message_total: number };
        return (
          detail.messages.length < detail.message_total &&
          !JSON.stringify(detail.messages).includes(finalReply)
        );
      })
      .toBe(true);
    await page.goto("/claudecode/e2e-large-output");
    await expect(page.getByText(finalReply, { exact: true })).toBeVisible();
    await expect(page.getByTestId("session-message-paging-footer")).toHaveCount(0);
  } finally {
    await rm(fixture, { force: true });
  }
});
