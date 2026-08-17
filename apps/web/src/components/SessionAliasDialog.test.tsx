import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionAliasDialog } from "./SessionAliasDialog";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    expect(document.querySelector(".motion-backdrop")).not.toBeNull();
    expect(screen.getByRole("dialog").className).toContain("motion-modal");
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

  it("removes the alias when saving the source title", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionAliasDialog
        target={{
          agentKey: "codex",
          sessionId: "session-1",
          title: "Source title",
          displayTitle: "Current custom title",
        }}
        onClose={vi.fn()}
        onSave={onSave}
        onRemove={onRemove}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Session title" }), {
      target: { value: "Source title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledOnce());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("associates a save error with the title input for screen readers", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Title already in use"));
    render(
      <SessionAliasDialog
        target={{ agentKey: "codex", sessionId: "session-1", title: "Source title" }}
        onClose={vi.fn()}
        onSave={onSave}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Session title" });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());

    const errorMessage = await screen.findByText("Title already in use");
    expect(errorMessage.id).toBe("session-alias-error");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("session-alias-error");
  });

  it("ignores a completed save from the previous target", async () => {
    const firstRequest = deferred<void>();
    const secondRequest = deferred<void>();
    const onClose = vi.fn();
    const onSave = vi
      .fn()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { rerender } = render(
      <SessionAliasDialog
        target={{ agentKey: "codex", sessionId: "session-1", title: "First" }}
        onClose={onClose}
        onSave={onSave}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Session title" }), {
      target: { value: "Renamed first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());

    rerender(
      <SessionAliasDialog
        target={{ agentKey: "codex", sessionId: "session-2", title: "Second" }}
        onClose={onClose}
        onSave={onSave}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect((screen.getByRole("textbox", { name: "Session title" }) as HTMLInputElement).value).toBe(
      "Second",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Session title" }), {
      target: { value: "Renamed second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstRequest.resolve();
      await firstRequest.promise;
    });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      secondRequest.resolve();
      await secondRequest.promise;
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores a rejected save from the previous target", async () => {
    const request = deferred<void>();
    const onClose = vi.fn();
    const onSave = vi.fn().mockReturnValue(request.promise);
    const { rerender } = render(
      <SessionAliasDialog
        target={{ agentKey: "codex", sessionId: "session-1", title: "First" }}
        onClose={onClose}
        onSave={onSave}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Session title" }), {
      target: { value: "Renamed first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());

    rerender(
      <SessionAliasDialog
        target={{ agentKey: "codex", sessionId: "session-2", title: "Second" }}
        onClose={onClose}
        onSave={onSave}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await act(async () => {
      request.reject(new Error("First failed"));
      await request.promise.catch(() => undefined);
    });

    expect(screen.queryByText("First failed")).toBeNull();
    expect((screen.getByRole("button", { name: "Save title" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("submits at most one request while saving", async () => {
    const request = deferred<void>();
    const onSave = vi.fn().mockReturnValue(request.promise);
    render(
      <SessionAliasDialog
        target={{ agentKey: "codex", sessionId: "session-1", title: "Source title" }}
        onClose={vi.fn()}
        onSave={onSave}
        onRemove={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Session title" });
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    await act(async () => {
      request.resolve();
      await request.promise;
    });
  });
});
