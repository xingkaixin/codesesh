import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Force a render failure to exercise the router error boundary.
vi.mock("./App", () => ({
  default: () => {
    throw new Error("render failed");
  },
}));

import { appRouterRoutes } from "./router";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderRoute(path: string) {
  const router = createMemoryRouter(appRouterRoutes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("app router recovery", () => {
  it("shows a safe fallback when route rendering throws", async () => {
    renderRoute("/");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The application route failed to render.",
    );
  });
});
