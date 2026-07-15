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
});
