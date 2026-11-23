import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Menu } from "./popup-menu";

afterEach(cleanup);

function Harness() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState("en");

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger ref={triggerRef} aria-label="Preferences">
        Preferences
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={8}>
          <Menu.Popup finalFocus={triggerRef}>
            <Menu.RadioGroup value={choice} onValueChange={setChoice}>
              <Menu.RadioItem value="en" closeOnClick>
                English
              </Menu.RadioItem>
              <Menu.RadioItem value="zh-CN" closeOnClick>
                简体中文
              </Menu.RadioItem>
            </Menu.RadioGroup>
            <Menu.Item>Shortcuts</Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

describe("PopupMenu keyboard focus", () => {
  it("focuses the first item on ArrowDown, navigates with arrow keys, and restores trigger focus on close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Preferences" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const english = screen.getByRole("menuitemradio", { name: "English" });
    const chinese = screen.getByRole("menuitemradio", { name: "简体中文" });
    const shortcuts = screen.getByRole("menuitem", { name: "Shortcuts" });
    expect(document.activeElement).toBe(english);

    fireEvent.keyDown(english, { key: "ArrowDown" });
    expect(document.activeElement).toBe(chinese);

    fireEvent.keyDown(chinese, { key: "ArrowDown" });
    expect(document.activeElement).toBe(shortcuts);

    fireEvent.click(chinese);
    await Promise.resolve();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
