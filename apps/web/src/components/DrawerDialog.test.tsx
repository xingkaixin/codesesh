import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DrawerDialog } from "./DrawerDialog";

afterEach(cleanup);

describe("DrawerDialog", () => {
  it("uses the shared backdrop and drawer motion primitives", () => {
    render(
      <DrawerDialog open onOpenChange={vi.fn()} title="Test drawer" variant="mobile">
        Drawer content
      </DrawerDialog>,
    );

    expect(document.querySelector(".motion-backdrop")).not.toBeNull();
    expect(document.querySelector(".motion-drawer")).not.toBeNull();
  });

  it("exposes the opening side to placement and motion styles", () => {
    render(
      <DrawerDialog open onOpenChange={vi.fn()} title="Left drawer" variant="mobile" side="left">
        Drawer content
      </DrawerDialog>,
    );

    const drawer = document.querySelector(".motion-drawer");
    expect(drawer?.getAttribute("data-drawer-side")).toBe("left");
    expect(drawer?.classList.contains("left-0")).toBe(true);
  });
});
