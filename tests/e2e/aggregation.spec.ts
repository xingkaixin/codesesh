import { expect, test } from "./test-fixtures.js";
import type { Locator } from "playwright/test";
import type { DashboardData } from "@codesesh/core/contract";

const CODEX_SESSION_ID = "019daaaa-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

/** The overview KPI cards carry no test id; each is a Panel whose text opens with
 *  its own eyebrow label, which makes the label a stable anchor. */
function sessionsKpi(dashboard: Locator): Locator {
  return dashboard.locator("section").filter({ hasText: /^Sessions/ });
}

test("keeps model colors consistent across token and cost rankings and project scopes", async ({
  page,
}) => {
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
  const tokens = page.getByRole("region", { name: "Tokens by Model", exact: true });
  const cost = page.getByRole("region", { name: "Cost by Model", exact: true });
  const tokenSwatch = (model: string) =>
    tokens.getByRole("button", { name: new RegExp(`^${model}:`) }).locator("[aria-hidden]");
  const costSwatch = (model: string) =>
    cost
      .getByRole("list")
      .getByRole("listitem")
      .filter({ hasText: model })
      .locator("[aria-hidden]");
  await expect(tokens.getByRole("button", { name: /^sonnet:/ })).toBeVisible();
  const sonnetColor = await tokenSwatch("sonnet").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(costSwatch("sonnet")).toHaveCSS("background-color", sonnetColor);
  const haikuColor = await tokenSwatch("haiku").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(costSwatch("haiku")).toHaveCSS("background-color", haikuColor);
  expect(sonnetColor).not.toBe(haikuColor);
  const chart = tokens.getByRole("listbox");
  await chart.getByRole("option").first().focus();
  await expect(tokens.getByRole("tooltip")).toContainText("sonnet");
  await page.keyboard.press("ArrowRight");
  await expect(tokens.getByRole("tooltip")).toContainText("haiku");
  await expect(tokens.getByRole("tooltip")).toContainText("20 tokens");

  await page.goto("/projects");
  await page
    .locator("main")
    .getByRole("link", { name: /codesesh-e2e/ })
    .click();
  await expect(tokens.getByRole("button", { name: /^sonnet:/ })).toBeVisible();
  await expect(tokenSwatch("sonnet")).toHaveCSS("background-color", sonnetColor);
});

test("aggregates Claude and Codex sessions under one project", async ({ page }) => {
  await page.goto("/");

  const dashboard = page.getByTestId("dashboard");
  await expect(sessionsKpi(dashboard)).toContainText("2");
  await expect(dashboard.getByText("1 projects · 2 agents in scope")).toBeVisible();
  // Neither session has a cost, so the agent bars rank and read by sessions.
  const agentColumns = dashboard.getByTestId("overview-agent-row");
  await expect(agentColumns).toHaveCount(2);
  const claude = agentColumns.filter({ hasText: "Claude Code" });
  await expect(claude).toContainText("1");
  await expect(claude.getByRole("img", { name: "Claude Code", exact: true })).toBeVisible();
  const codex = agentColumns.filter({ hasText: "Codex" });
  await expect(codex).toContainText("1");
  await expect(codex.getByRole("img", { name: "Codex", exact: true })).toBeVisible();

  await page.goto("/projects");
  const project = page.locator("main").getByRole("link", { name: /codesesh-e2e/ });
  await expect(project).toContainText("2 sessions");
  await expect(project).toContainText("Claude Code · 1");
  await expect(project).toContainText("Codex · 1");
  await project.click();

  await expect(page.getByRole("heading", { level: 1, name: "codesesh-e2e" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Claude Code · 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex · 1" })).toBeVisible();
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
  await page.getByRole("searchbox", { name: "Search Sessions" }).fill("codex-shared-needle");
  await page.getByRole("button", { name: "Search" }).click();

  const result = page
    .getByRole("link")
    .filter({ hasText: "Codex aggregation smoke session" })
    .first();
  await expect(result).toContainText("codex-shared-needle");
  await result.click();

  await expect(page).toHaveURL(new RegExp(`/codex/${CODEX_SESSION_ID}$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Codex aggregation smoke session" }),
  ).toBeVisible();
  await expect(
    page.getByText("Codex joined the shared project with codex-shared-needle."),
  ).toBeVisible();
});
