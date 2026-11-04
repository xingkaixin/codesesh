import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionAliasDialog } from "./SessionAliasDialog";

afterEach(cleanup);

describe("SessionAliasDialog", () => {
  it("removes the alias when saving the source title", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionAliasDialog
        target={{
          agentKey: "codex",
          sessionId: "session-1",
          title: "Source title",
          displayTitle: "Current custom title",
        }}
        onClose={vi.fn()}
        onSave={onSave}
        onRemove={onRemove}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Session title" }), {
      target: { value: "Source title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledOnce());
    expect(onSave).not.toHaveBeenCalled();
  });
});
