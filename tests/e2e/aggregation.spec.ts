import { expect, test } from "./test-fixtures.js";
import type { Locator } from "playwright/test";

const CODEX_SESSION_ID = "019daaaa-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

/** The overview KPI cards carry no test id; each is a Panel whose text opens with
 *  its own eyebrow label, which makes the label a stable anchor. */
function sessionsKpi(dashboard: Locator): Locator {
  return dashboard.locator("section").filter({ hasText: /^Sessions/ });
}

test("aggregates Claude and Codex sessions under one project", async ({ page }) => {
  await page.goto("/");

  const dashboard = page.getByTestId("dashboard");
  await expect(sessionsKpi(dashboard)).toContainText("2");
  await expect(dashboard.getByText("1 projects · 2 agents in scope")).toBeVisible();
  const agentRows = dashboard.getByTestId("overview-agent-row");
  await expect(agentRows).toHaveCount(2);
  await expect(agentRows.filter({ hasText: "Claude Code" })).toContainText("1 · $0.00");
  await expect(agentRows.filter({ hasText: "Codex" })).toContainText("1 · $0.00");
  const projectRow = dashboard.getByTestId("overview-project-row");
  await expect(projectRow).toHaveCount(1);
  await expect(projectRow).toContainText("codesesh-e2e");
  await expect(projectRow.getByRole("img", { name: "Codex", exact: true })).toBeVisible();
  await expect(projectRow.getByRole("img", { name: "Claude Code", exact: true })).toBeVisible();
  await expect(projectRow).not.toContainText("Codex");
  await expect(projectRow).not.toContainText("Claude Code");

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
        results?: Array<{ session?: { id?: string } }>;
      };
      return body.results?.some((result) => result.session?.id === CODEX_SESSION_ID);
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
