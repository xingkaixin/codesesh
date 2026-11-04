import { expect, test } from "./test-fixtures.js";
import type { Locator } from "playwright/test";

/** The overview metrics carry no test id; each is a section whose text opens with
 *  its own label, which makes the label a stable anchor. */
function sessionsKpi(dashboard: Locator): Locator {
  return dashboard.locator("section").filter({ hasText: /^Sessions/ });
}

test("aggregates Claude and Codex sessions under one project", async ({ page }) => {
  await page.goto("/");

  const dashboard = page.getByTestId("dashboard");
  await expect(sessionsKpi(dashboard)).toContainText("2");
  await expect(dashboard.getByText(/2 agents · 1 projects/)).toBeVisible();
  const agentColumns = dashboard.getByTestId("overview-agent-row");
  await expect(agentColumns).toHaveCount(2);
  await expect(agentColumns.filter({ hasText: "Claude Code" })).toContainText("1");
  await expect(agentColumns.filter({ hasText: "Codex" })).toContainText("1");

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
