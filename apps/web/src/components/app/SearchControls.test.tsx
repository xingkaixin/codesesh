import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchControls, type SearchControlsHandle } from "./SearchControls";

afterEach(cleanup);

describe("SearchControls", () => {
  it("keeps draft input local and submits it as a semantic query", () => {
    const onSubmit = vi.fn();
    render(<SearchControls onSubmit={onSubmit} />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "  query  " } });
    fireEvent.submit(input.closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith("  query  ");
  });

  it("lets keyboard commands focus, select, and clear the input", () => {
    const ref = createRef<SearchControlsHandle>();
    render(<SearchControls ref={ref} onSubmit={vi.fn()} />);

    const input = screen.getByRole<HTMLInputElement>("searchbox");
    fireEvent.change(input, { target: { value: "query" } });
    act(() => ref.current?.focusAndSelect());
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    act(() => ref.current?.clear());
    expect(input.value).toBe("");
  });
});
