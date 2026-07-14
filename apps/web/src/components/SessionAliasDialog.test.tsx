import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionAliasDialog } from "./SessionAliasDialog";

afterEach(cleanup);

describe("SessionAliasDialog", () => {
  it("starts editing from the current visible title", () => {
    render(
      <SessionAliasDialog
        target={{
          agentKey: "codex",
          sessionId: "session-1",
          title: "Source title",
          displayTitle: "Current custom title",
        }}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect((screen.getByRole("textbox", { name: "Session title" }) as HTMLInputElement).value).toBe(
      "Current custom title",
    );
    expect(screen.queryByText(/Original title/)).toBeNull();
  });

  it("uses the source title when no custom title exists", () => {
    render(
      <SessionAliasDialog
        target={{ agentKey: "codex", sessionId: "session-1", title: "Source title" }}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect((screen.getByRole("textbox", { name: "Session title" }) as HTMLInputElement).value).toBe(
      "Source title",
    );
  });
});
