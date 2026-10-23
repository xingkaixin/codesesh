import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SourceNode } from "@codesesh/contract";
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
const resume = { canResume: true, resumeDescriptionId: "resume-description" };

it("identifies an offline source and where to run its resume command", () => {
  const { client, Wrapper } = createQueryWrapper();
  client.setQueryData(["source-nodes"], { nodes: [node] });
  render(<SessionSourceDetails sourceNodeId={node.id} {...resume} />, {
    wrapper: Wrapper,
  });

  expect(screen.getByText(/Offline\. Saved history remains available/)).toBeTruthy();
  expect(screen.getByText(/Source last synced:/).textContent).toContain(
    new Date(node.lastConfirmedAt!).toLocaleString("en-US"),
  );
  expect(
    screen.getByText("Paths belong to the source machine. Files are not transferred."),
  ).toBeTruthy();
  expect(document.getElementById(resume.resumeDescriptionId)?.textContent).toBe(
    "Run this command on Office Mac, in a POSIX-compatible shell.",
  );
});

it("names the source machine for remote commands and the CodeSesh host for local ones", () => {
  const { Wrapper } = createQueryWrapper();
  const view = render(<SessionSourceDetails sourceNodeId="unknown-worker" {...resume} />, {
    wrapper: Wrapper,
  });
  expect(screen.getByText("Node status unavailable")).toBeTruthy();
  expect(screen.getByText(/Run this command on unknown-worker/)).toBeTruthy();
  view.rerender(<SessionSourceDetails sourceNodeId="local" {...resume} />);
  expect(screen.getByText(/Run this command on the machine running CodeSesh/)).toBeTruthy();
  expect(screen.queryByText("Node status unavailable")).toBeNull();
  view.rerender(<SessionSourceDetails sourceNodeId="local" {...resume} canResume={false} />);
  expect(screen.queryByText(/Run this command/)).toBeNull();
});
