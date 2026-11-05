import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessagePagingControls } from "./MessagePagingControls";

afterEach(cleanup);

it("stops loading all messages after a page failure until the user restarts it", () => {
  const loadMore = vi.fn();
  const controls = (loaded: number, failed: boolean) => (
    <MessagePagingControls
      loaded={loaded}
      total={3}
      paging={{ loading: false, failed, loadMore }}
      showLoadAll
    />
  );
  const { rerender } = render(controls(1, false));

  fireEvent.click(screen.getByRole("button", { name: "Load all messages" }));
  rerender(controls(1, true));
  rerender(controls(2, false));

  expect(loadMore).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Load all messages" }).hasAttribute("disabled")).toBe(
    false,
  );
});
