import { expect, test } from "./test-fixtures.js";
import type { Locator } from "playwright/test";
import type { DashboardData } from "@codesesh/contract";

const CODEX_SESSION_ID = "019daaaa-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

/** The overview metrics carry no test id; each is a section whose text opens with
 *  its own label, which makes the label a stable anchor. */
function sessionsKpi(dashboard: Locator): Locator {
  return dashboard.locator("section").filter({ hasText: /^Sessions/ });
}

test("keeps model colors consistent across models and project scopes", async ({ page }) => {
  await page.route("**/api/dashboard?*", async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as DashboardData;
    const project = new URL(route.request().url()).searchParams.has("projectKey");
    const models = project
      ? [{ model: "sonnet", tokens: 80, sessions: 1 }]
      : [
          { model: "sonnet", tokens: 80, sessions: 1 },
          { model: "haiku", tokens: 20, sessions: 1 },
        ];
    await route.fulfill({
      response,
      json: {
        ...data,
        totals: { ...data.totals, tokens: project ? 80 : 100, cost: 10 },
        modelDistribution: models,
        modelCost: [
          { model: "haiku", cost: 9, costRecorded: 9, costEstimated: 0 },
          { model: "sonnet", cost: 1, costRecorded: 1, costEstimated: 0 },
        ],
      },
    });
  });
  await page.goto("/");
  const models = page.getByRole("region", { name: "By model", exact: true });
  const row = (model: string) => models.getByRole("row").filter({ hasText: model });
  const swatch = (model: string) => row(model).locator("[aria-hidden]").first();
  await expect(row("sonnet")).toContainText("$1.00");
  await expect(row("haiku")).toContainText("$9.00");
  const sonnetColor = await swatch("sonnet").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const haikuColor = await swatch("haiku").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(sonnetColor).not.toBe(haikuColor);

  await page.goto("/projects");
  await page
    .locator("main")
    .getByRole("link", { name: /codesesh-e2e/ })
    .click();
  await expect(row("sonnet")).toBeVisible();
  await expect(swatch("sonnet")).toHaveCSS("background-color", sonnetColor);
});

test("aggregates Claude and Codex sessions under one project", async ({ page }) => {
  await page.goto("/");

  const dashboard = page.getByTestId("dashboard");
  await expect(sessionsKpi(dashboard)).toContainText("2");
  await expect(dashboard.getByText(/2 agents · 1 projects/)).toBeVisible();
  const agentColumns = dashboard.getByTestId("overview-agent-row");
  await expect(agentColumns).toHaveCount(2);
  const claude = agentColumns.filter({ hasText: "Claude Code" });
  await expect(claude).toContainText("1");
  await expect(claude.getByRole("img", { name: "Claude Code", exact: true })).toBeVisible();
  const codex = agentColumns.filter({ hasText: "Codex" });
  await expect(codex).toContainText("1");
  await expect(codex.getByRole("img", { name: "Codex", exact: true })).toBeVisible();

  await page.goto("/projects");
  const project = page.locator("main").getByRole("row", { name: /codesesh-e2e/ });
  await expect(project.getByRole("cell").nth(1)).toHaveText("2");
  await expect(project).toContainText("Claude Code · 1");
  await expect(project).toContainText("Codex · 1");
  await project.getByRole("link", { name: /codesesh-e2e/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: "codesesh-e2e" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Claude Code 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex 1" })).toBeVisible();
  await expect(sessionsKpi(page.getByTestId("dashboard"))).toContainText("2");
});

test("searches and opens the aggregated Codex session", async ({ page }) => {
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/search?q=codex-shared-needle");
      const body = (await response.json()) as {
        results?: Array<{ session?: { reference?: { sessionId?: string } } }>;
      };
      return body.results?.some(
        (result) => result.session?.reference?.sessionId === CODEX_SESSION_ID,
      );
    })
    .toBe(true);

  await page.goto("/");
  await page.getByRole("button", { name: "Search Sessions" }).click();
  const search = page.getByRole("searchbox", { name: "Search Sessions" });
  await search.fill("codex-shared-needle");
  await search.press("Enter");

  const result = page
    .getByRole("link")
    .filter({ hasText: "Codex aggregation smoke session" })
    .first();
  await expect(result).toContainText("codex-shared-needle");
  await result.click();

  await expect(page).toHaveURL(new RegExp(`/codex/${CODEX_SESSION_ID}#message-1$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Codex aggregation smoke session" }),
  ).toBeVisible();
  await expect(
    page.getByText("Codex joined the shared project with codex-shared-needle."),
  ).toBeVisible();
  await expect(page.locator("#session-message-1-block-0")).toBeInViewport();
});
