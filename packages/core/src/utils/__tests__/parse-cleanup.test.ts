import { describe, expect, it } from "vitest";
import { cleanDisplayText, isInternalEventType } from "../parse-cleanup.js";

describe("cleanDisplayText", () => {
  it("removes internal control tag blocks", () => {
    const text = [
      "Visible before",
      "<command-name>pwd</command-name>",
      "<command-message>run local command</command-message>",
      "<local-command-caveat>local command metadata</local-command-caveat>",
      "<local-command-stdout>/tmp/project</local-command-stdout>",
      "<system-reminder>hidden policy reminder</system-reminder>",
      "Visible after",
    ].join("\n");

    expect(cleanDisplayText(text)).toBe("Visible before\nVisible after");
  });

  it("returns null when only internal tags remain", () => {
    expect(cleanDisplayText("<command-name>clear</command-name>")).toBeNull();
  });

  it("unwraps command arguments without discarding their content", () => {
    expect(cleanDisplayText("<command-args>Review the auth flow</command-args>")).toBe(
      "Review the auth flow",
    );
    expect(cleanDisplayText("<command-args></command-args>")).toBeNull();
  });

  it("preserves regular spacing and indentation", () => {
    const text = "  const value =  1;\n\treturn value;\n| col  | value |";

    expect(cleanDisplayText(text)).toBe(text);
  });
});

describe("isInternalEventType", () => {
  it("matches internal event aliases", () => {
    expect(isInternalEventType("file-history snapshot")).toBe(true);
    expect(isInternalEventType("queue_operation")).toBe(true);
    expect(isInternalEventType("last prompt")).toBe(true);
  });
});
