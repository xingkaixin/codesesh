import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

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
  it("shows the route response for malformed URL encoding", async () => {
    renderRoute("/%E0%A4%A");

    expect((await screen.findByRole("alert")).textContent).toBe("400 Bad Request");
  });

  it("shows a safe fallback when route rendering throws", async () => {
    renderRoute("/");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The application route failed to render.",
    );
  });
});
