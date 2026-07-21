import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

afterEach(cleanup);

describe("ThemeToggle", () => {
  it("labels the button with the current theme", () => {
    render(<ThemeToggle theme="light" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Theme: Light/ })).toBeTruthy();
  });

  it.each([
    ["light", "dark"],
    ["dark", "system"],
    ["system", "light"],
  ] as const)("cycles from %s to %s on click", (theme, next) => {
    const onChange = vi.fn();
    render(<ThemeToggle theme={theme} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith(next);
  });
});
