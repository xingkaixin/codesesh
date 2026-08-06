import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriStateCheckbox } from "./tri-state-checkbox";

afterEach(cleanup);

describe("TriStateCheckbox", () => {
  it("reports a mixed selection", () => {
    render(<TriStateCheckbox state="indeterminate" onToggle={vi.fn()} label="Tools" />);
    const checkbox = screen.getByRole("checkbox", { name: "Tools" }) as HTMLInputElement;

    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.checked).toBe(false);
  });

  it("reports checked and unchecked states", () => {
    const { rerender } = render(
      <TriStateCheckbox state="checked" onToggle={vi.fn()} label="Tools" />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Tools" }) as HTMLInputElement;

    expect(checkbox.checked).toBe(true);
    expect(checkbox.indeterminate).toBe(false);

    rerender(<TriStateCheckbox state="unchecked" onToggle={vi.fn()} label="Tools" />);

    expect(checkbox.checked).toBe(false);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<TriStateCheckbox state="indeterminate" onToggle={onToggle} label="Tools" />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Tools" }));

    expect(onToggle).toHaveBeenCalledOnce();
  });
});
