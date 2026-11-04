import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Surface({ failed }: { failed: boolean }) {
  if (failed) throw new Error("broken surface");
  return <p>Recovered surface</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("recovers when its reset key changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ErrorBoundary key="/broken">
        <Surface failed />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();

    view.rerender(
      <ErrorBoundary key="/healthy">
        <Surface failed={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Recovered surface")).toBeTruthy();
  });
});
