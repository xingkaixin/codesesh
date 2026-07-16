import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActionsMenu } from "./SessionActionsMenu";

afterEach(cleanup);

describe("SessionActionsMenu", () => {
  it("loops focus through menu items with arrow keys", async () => {
    render(<SessionActionsMenu bookmarked={false} onRename={vi.fn()} onToggleBookmark={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Session options" });
    trigger.focus();
    fireEvent.click(trigger);
    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    const bookmarkItem = screen.getByRole("menuitem", { name: "Add bookmark" });

    await waitFor(() => expect(document.activeElement).toBe(renameItem));
    fireEvent.keyDown(renameItem, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(bookmarkItem));
    fireEvent.keyDown(bookmarkItem, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(renameItem));
    fireEvent.keyDown(renameItem, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(bookmarkItem));
  });

  it("returns focus to the trigger when Escape closes the menu", async () => {
    render(<SessionActionsMenu bookmarked={false} onRename={vi.fn()} onToggleBookmark={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Session options" });

    trigger.focus();
    fireEvent.click(trigger);
    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    await waitFor(() => expect(document.activeElement).toBe(renameItem));
    fireEvent.keyDown(renameItem, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("runs the selected action, closes, and returns focus", async () => {
    const onRename = vi.fn();
    render(
      <SessionActionsMenu bookmarked={false} onRename={onRename} onToggleBookmark={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: "Session options" });

    trigger.focus();
    fireEvent.click(trigger);
    const renameItem = screen.getByRole("menuitem", { name: "Rename" });
    await waitFor(() => expect(document.activeElement).toBe(renameItem));
    fireEvent.click(renameItem);

    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("returns focus to the trigger when an outside pointer closes the menu", async () => {
    render(
      <>
        <SessionActionsMenu bookmarked={false} onRename={vi.fn()} onToggleBookmark={vi.fn()} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Session options" });

    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })),
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
