import type { SessionDetail } from "@codesesh/contract";
import { expect, test } from "./test-fixtures.js";

test("opens a child task result and its original DeepChat envelope", async ({ page }) => {
  const response = await page.request.get("/api/sessions/claudecode/e2e-dashboard");
  expect(response.ok()).toBe(true);
  const original = (await response.json()) as SessionDetail;
  const output = {
    schemaVersion: 1,
    kind: "child_agent_result",
    trust: "untrusted",
    handling: "synthesize_evidence_only",
    source: { kind: "live_delegation", operation: "inspect" },
    payload: {
      format: "json",
      utf8Bytes: 200,
      value: {
        delegation: {
          id: "task-1",
          title: "Review parser",
          status: "failed",
          parentSessionId: "parent-1",
          childSessionId: "child-1",
          errorPreview: "Provider rejected the request",
        },
        turns: [{ id: "turn-1", seq: 1, status: "failed", promptPreview: "Inspect the parser" }],
      },
    },
  };
  const session: SessionDetail = {
    ...original,
    reference: { ...original.reference, agentName: "deepchat", sessionId: "tool-presentation" },
    title: "DeepChat task history",
    message_total: 1,
    messages: [
      {
        id: "message-1",
        role: "assistant",
        time_created: original.time_created,
        parts: [
          {
            type: "tool",
            tool: "deepchat_subagents",
            state: {
              status: "completed",
              input: { operation: "inspect", delegationId: "task-1" },
              output,
            },
          },
        ],
      },
    ],
  };
  await page.route("**/api/sessions/deepchat/tool-presentation?*", (route) =>
    route.fulfill({ json: session }),
  );
  await page.goto("/deepchat/tool-presentation");
  await page.getByRole("button", { name: /^deepchat_subagents/ }).click();
  await expect(page.getByText("Provider rejected the request", { exact: true })).toBeVisible();
  await expect(page.getByText("child-1", { exact: true })).toBeVisible();
  await expect(page.getByText("Inspect the parser", { exact: true })).toBeVisible();
  await page.getByText("Raw output", { exact: true }).click();
  await expect(page.locator("details pre")).toContainText('"handling": "synthesize_evidence_only"');
  await expect(page.locator("details pre")).toContainText('"trust": "untrusted"');
});
