import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/contract/test-fixtures";
import { ScanStatusProvider } from "../../hooks/useScanStatus";
import { ScanStatusNotice } from "./ScanStatusNotice";

afterEach(cleanup);

it("opens collection details from the header and closes them with Escape", async () => {
  render(
    <ScanStatusProvider
      initialStatus={{
        ...SAMPLE_SCAN_STATUS_EVENT,
        sources: {
          codex: { presence: "available", complete: true },
          cursor: { presence: "not-found", complete: true },
        },
      }}
    >
      <ScanStatusNotice visible />
    </ScanStatusProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Local collection View status" });
  expect(screen.queryByText("Available history remains searchable.")).toBeNull();
  fireEvent.click(trigger);
  expect(await screen.findByText("Available history remains searchable.")).toBeTruthy();
  expect(screen.getByText("Codex")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
