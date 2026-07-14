import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActionsMenu } from "./SessionActionsMenu";

afterEach(cleanup);

describe("SessionActionsMenu", () => {
  it("closes when focus leaves the menu", () => {
    render(
      <>
        <SessionActionsMenu bookmarked={false} onRename={vi.fn()} onToggleBookmark={vi.fn()} />
        <button type="button">Elsewhere</button>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.focus(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when Escape is pressed", () => {
    render(<SessionActionsMenu bookmarked={false} onRename={vi.fn()} onToggleBookmark={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });
});
