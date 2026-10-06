import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SourceNode } from "../../lib/api";
import { createQueryWrapper } from "../../test/query-wrapper";
import { SessionSourceDetails } from "./SessionSourceDetails";

afterEach(cleanup);

const node: SourceNode = {
  id: "worker-one",
  name: "Office Mac",
  version: "1.2.3",
  pairedAt: 1,
  lastSeen: 1,
  lastConfirmedAt: 1_700_000_000_000,
  revoked: false,
  incompleteSessions: 0,
  collectionComplete: true,
  queue: null,
  error: null,
  agents: {},
  ignoredSources: [] as string[],
};
const resumeSession = {
  resumeCommandPrefix: "codex resume",
  sessionId: "same-session",
  directory: "/source/worktree",
};

it("identifies an offline source and copies a command to run on that machine", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const { client, Wrapper } = createQueryWrapper();
  client.setQueryData(["source-nodes"], { nodes: [node] });
  render(<SessionSourceDetails sourceNodeId={node.id} resumeSession={resumeSession} />, {
    wrapper: Wrapper,
  });

  expect(screen.getByText("Source: Office Mac").getAttribute("title")).toBe(node.id);
  expect(screen.getByText(/Offline\. Saved history remains available/)).toBeTruthy();
  expect(screen.getByText(/Source last synced:/).textContent).toContain(
    new Date(node.lastConfirmedAt!).toLocaleString("en-US"),
  );
  expect(
    screen.getByText("Paths belong to the source machine. Files are not transferred."),
  ).toBeTruthy();
  const button = screen.getByRole("button", { name: /Copy resume command/ });
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
    "Run this command on Office Mac, in a POSIX-compatible shell.",
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("cd '/source/worktree' && codex resume 'same-session'"),
  );
});

it("keeps unknown source identity visible and names the CodeSesh host for local commands", () => {
  const { Wrapper } = createQueryWrapper();
  const view = render(
    <SessionSourceDetails sourceNodeId="unknown-worker" resumeSession={resumeSession} />,
    { wrapper: Wrapper },
  );
  expect(screen.getByText("Source: unknown-worker")).toBeTruthy();
  expect(screen.getByText("Node status unavailable")).toBeTruthy();
  expect(screen.getByText(/Run this command on unknown-worker/)).toBeTruthy();
  view.rerender(<SessionSourceDetails sourceNodeId="local" resumeSession={resumeSession} />);
  expect(screen.getByText("Source: Local source")).toBeTruthy();
  expect(screen.getByText(/Run this command on the machine running CodeSesh/)).toBeTruthy();
  expect(screen.queryByText("Node status unavailable")).toBeNull();
  view.rerender(
    <SessionSourceDetails
      sourceNodeId="local"
      resumeSession={{ ...resumeSession, resumeCommandPrefix: null }}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText(/Run this command/)).toBeNull();
});
