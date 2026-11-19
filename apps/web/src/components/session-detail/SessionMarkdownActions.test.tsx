import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SessionDetail } from "@codesesh/contract";
import { SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMarkdownActions } from "./SessionMarkdownActions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("triggers a .md download from SessionMarkdownActions without requiring an extra fetch", async () => {
  vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  const session: SessionDetail = {
    ...SAMPLE_SESSION_HEAD,
    display_title: "Exportable Session",
    messages: [
      {
        id: "m1",
        role: "user",
        time_created: 1,
        parts: [{ type: "text", text: "Hello from markdown export" }],
      },
    ],
  };

  const createdBlobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    if (value instanceof Blob) createdBlobs.push(value);
    return "blob:exportable-session";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

  let downloadedName: string | null = null;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadedName = this.download;
  });

  const { getByRole } = render(<SessionMarkdownActions session={session} />);
  fireEvent.click(getByRole("button", { name: "Download .md" }));

  await waitFor(() => {
    expect(downloadedName).toBe("Exportable-Session.md");
    expect(getByRole("status").textContent).toBe("Session downloaded as Markdown.");
  });
  expect(await createdBlobs[0]?.text()).toContain("Hello from markdown export");
});
