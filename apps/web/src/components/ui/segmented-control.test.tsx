import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./segmented-control";

const OPTIONS = [
  { value: "tokens", label: "Token" },
  { value: "sessions", label: "会话数" },
  { value: "messages", label: "消息数" },
] as const;

afterEach(cleanup);

describe("SegmentedControl", () => {
  it("exposes a radiogroup with the selected option checked", () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="sessions"
        onChange={vi.fn()}
        ariaLabel="用量指标"
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "用量指标" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "会话数" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("aria-checked")).toBe("false");
  });

  it("makes only the selected option tabbable", () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value="sessions"
        onChange={vi.fn()}
        ariaLabel="用量指标"
      />,
    );

    expect(screen.getByRole("radio", { name: "会话数" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("tabindex")).toBe("-1");
  });

  it("reports the clicked option", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tokens"
        onChange={onChange}
        ariaLabel="用量指标"
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "消息数" }));

    expect(onChange).toHaveBeenCalledWith("messages");
  });

  it("moves selection and focus with the arrow keys, wrapping at both ends", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={OPTIONS}
        value="tokens"
        onChange={onChange}
        ariaLabel="用量指标"
      />,
    );
    const first = screen.getByRole("radio", { name: "Token" });

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("sessions");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "会话数" }));

    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("messages");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "消息数" }));
  });

  it("keeps the first option reachable when nothing matches the value", () => {
    render(
      <SegmentedControl
        options={OPTIONS}
        value={"unknown" as "tokens"}
        onChange={vi.fn()}
        ariaLabel="用量指标"
      />,
    );

    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Token" }).getAttribute("aria-checked")).toBe("false");
  });
});
