import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeRangeControl } from "./TimeRangeControl";

afterEach(cleanup);

describe("TimeRangeControl", () => {
  it("opens and applies the shared custom time range", async () => {
    const onSelectCustom = vi.fn();
    render(
      <TimeRangeControl
        window={{ days: 7 }}
        preset="7d"
        onSelectPreset={vi.fn()}
        onSelectCustom={onSelectCustom}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    await screen.findByRole("dialog", { name: "Custom time range" });

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-07-14" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply range" }));

    expect(onSelectCustom).toHaveBeenCalledWith("2026-07-01", "2026-07-14");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
