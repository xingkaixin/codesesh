import { describe, expect, it } from "vitest";
import type { BookmarkView } from "./state-handler-test-fixtures.js";
import {
  bookmarkScanSource,
  coreMocks,
  getResponsePayload,
  makeContext,
  scanSource,
  storedBookmark,
} from "./state-handler-test-fixtures.js";

const { StateStorageUnavailableError } = await import("@codesesh/core/runtime/state");
const { handleDeleteSessionAlias, handleGetBookmarks, handlePutSessionAlias } =
  await import("../bookmark-handlers.js");
const { handleGetSessions } = await import("../session-handlers.js");

describe("session alias caching", () => {
  const aliasRecord = {
    reference: { agentName: "codex", sessionId: "s1" },
    alias: "Renamed",
    updatedAt: 1,
  };

  it("queries alias storage once across repeated reads", () => {
    coreMocks.listSessionAliases.mockReturnValue([aliasRecord]);

    handleGetSessions(makeContext() as never, scanSource);
    handleGetSessions(makeContext() as never, scanSource);
    handleGetBookmarks(makeContext() as never, bookmarkScanSource);

    expect(coreMocks.listSessionAliases).toHaveBeenCalledTimes(1);
  });

  it("picks up a stored alias on the next read", async () => {
    coreMocks.listSessionAliases.mockReturnValue([]);
    handleGetSessions(makeContext() as never, scanSource);

    coreMocks.upsertSessionAlias.mockReturnValue(aliasRecord);
    coreMocks.listSessionAliases.mockReturnValue([aliasRecord]);
    await handlePutSessionAlias(
      makeContext({ body: { alias: "Renamed" }, param: { agent: "codex", id: "s1" } }) as never,
    );

    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    const after = makeContext();
    handleGetBookmarks(after as never, bookmarkScanSource);

    expect(getResponsePayload<{ bookmarks: BookmarkView[] }>(after).bookmarks[0]).toMatchObject({
      session: { display_title: "Renamed" },
    });
  });

  it("drops a removed alias on the next read", () => {
    coreMocks.listSessionAliases.mockReturnValue([aliasRecord]);
    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    handleGetBookmarks(makeContext() as never, bookmarkScanSource);

    coreMocks.listSessionAliases.mockReturnValue([]);
    handleDeleteSessionAlias(makeContext({ param: { agent: "codex", id: "s1" } }) as never);

    const after = makeContext();
    handleGetBookmarks(after as never, bookmarkScanSource);

    const bookmark = getResponsePayload<{ bookmarks: BookmarkView[] }>(after).bookmarks[0];
    expect(bookmark).toMatchObject({ availability: "available" });
    expect(
      bookmark?.availability === "available" ? bookmark.session : undefined,
    ).not.toHaveProperty("display_title");
  });

  it("retries an unavailable store and caches the recovered view", () => {
    coreMocks.listSessionAliases.mockImplementationOnce(() => {
      throw new StateStorageUnavailableError();
    });
    coreMocks.listSessionAliases.mockReturnValue([aliasRecord]);

    handleGetSessions(makeContext() as never, scanSource);
    coreMocks.listBookmarks.mockReturnValue([storedBookmark]);
    const recovered = makeContext();
    handleGetBookmarks(recovered as never, bookmarkScanSource);
    handleGetSessions(makeContext() as never, scanSource);

    expect(getResponsePayload<{ bookmarks: BookmarkView[] }>(recovered).bookmarks[0]).toMatchObject(
      { session: { display_title: "Renamed" } },
    );
    expect(coreMocks.listSessionAliases).toHaveBeenCalledTimes(2);
  });
});
