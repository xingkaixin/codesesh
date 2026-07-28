import { describe, expect, it } from "vitest";
import { inlineImageSource, resolveLocalMediaSource } from "./local-media-policy";

describe("CS-136: local media policy", () => {
  it.each([
    ["remote https", "https://tracker.example.com/pixel.png"],
    ["remote http", "http://tracker.example.com/pixel.png"],
    ["protocol relative", "//tracker.example.com/pixel.png"],
    ["remote with credentials", "https://user:pw@tracker.example.com/a.png"],
    ["blob reference", "blob:https://tracker.example.com/9f2b"],
    ["javascript url", "javascript:alert(1)"],
    ["non-image data url", "data:text/html;base64,PHNjcmlwdD4="],
    ["malformed", "https://"],
    ["empty", "   "],
  ])("refuses %s", (_name, value) => {
    expect(resolveLocalMediaSource(value)).toBeNull();
  });

  it("allows inline image data", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(resolveLocalMediaSource(src)).toBe(src);
  });

  it("allows a same-origin path served by CodeSesh", () => {
    const resolved = resolveLocalMediaSource("/api/sessions/codex/s1/asset.png");
    expect(resolved).toBe(`${window.location.origin}/api/sessions/codex/s1/asset.png`);
  });

  it("refuses an oversized inline payload", () => {
    const huge = `data:image/png;base64,${"A".repeat(13 * 1024 * 1024)}`;
    expect(resolveLocalMediaSource(huge)).toBeNull();
  });

  it("builds inline sources only for image mime types", () => {
    expect(inlineImageSource("image/png", "iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(inlineImageSource("text/html", "PHNjcmlwdD4=")).toBeNull();
    expect(inlineImageSource("image/png", "")).toBeNull();
  });
});
