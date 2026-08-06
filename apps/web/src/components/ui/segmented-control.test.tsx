import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./segmented-control";

const OPTIONS = [
  { value: "tokens", label: "Token" },
  { value: "sessions", label: "Sessions" },
  { value: "messages", label: "Messages" },
] as const;

afterEach(cleanup);

describe("SegmentedControl", () => {
  it("exposes a radiogroup with the selected option checked", () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="sessions"
        onChange={vi.fn()}
        ariaLabel="Usage metric"
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Usage metric" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Sessions" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("aria-checked")).toBe("false");
  });

  it("makes only the selected option tabbable", () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="sessions"
        onChange={vi.fn()}
        ariaLabel="Usage metric"
      />,
    );

    expect(screen.getByRole("radio", { name: "Sessions" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("tabindex")).toBe("-1");
  });

  it("reports the clicked option", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tokens"
        onChange={onChange}
        ariaLabel="Usage metric"
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Messages" }));

    expect(onChange).toHaveBeenCalledWith("messages");
  });

  it("moves selection and focus with the arrow keys, wrapping at both ends", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tokens"
        onChange={onChange}
        ariaLabel="Usage metric"
      />,
    );
    const first = screen.getByRole("radio", { name: "Token" });

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("sessions");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Sessions" }));

    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("messages");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Messages" }));
  });

  it("keeps the first option reachable when nothing matches the value", () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value={"unknown" as "tokens"}
        onChange={vi.fn()}
        ariaLabel="Usage metric"
      />,
    );

    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("aria-checked")).toBe("false");
  });
});
