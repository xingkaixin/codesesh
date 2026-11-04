import { describe, expect, it } from "vitest";
import { buildResumeCommand } from "./build-resume-command";

describe("buildResumeCommand", () => {
  it.each(["claude --resume", "codex resume", "kimi -r", "opencode -s", "pi --session"])(
    "emits the %s resume command",
    (resumeCommandPrefix) => {
      expect(
        buildResumeCommand({
          resumeCommandPrefix,
          sessionId: "abc-123",
          directory: "/Users/me/project",
        }),
      ).toBe(`cd '/Users/me/project' && ${resumeCommandPrefix} 'abc-123'`);
    },
  );

  it("shell-quotes adversarial directory containing a single quote", () => {
    const cmd = buildResumeCommand({
      resumeCommandPrefix: "claude --resume",
      sessionId: "id-1",
      directory: "/tmp/can't escape",
    });
    // The directory's literal ' is escaped via '\''; the shell sees: /tmp/can't escape
    expect(cmd).toBe("cd '/tmp/can'\\''t escape' && claude --resume 'id-1'");
  });

  it("shell-quotes adversarial sessionId", () => {
    const cmd = buildResumeCommand({
      resumeCommandPrefix: "claude --resume",
      sessionId: "x'; rm -rf /tmp/__bad",
      directory: "/tmp/proj",
    });
    expect(cmd).toBe("cd '/tmp/proj' && claude --resume 'x'\\''; rm -rf /tmp/__bad'");
  });

  it("falls back to no-cd command when directory is missing", () => {
    expect(buildResumeCommand({ resumeCommandPrefix: "claude --resume", sessionId: "abc" })).toBe(
      "claude --resume 'abc'",
    );
    expect(
      buildResumeCommand({
        resumeCommandPrefix: "claude --resume",
        sessionId: "abc",
        directory: null,
      }),
    ).toBe("claude --resume 'abc'");
    expect(
      buildResumeCommand({
        resumeCommandPrefix: "claude --resume",
        sessionId: "abc",
        directory: undefined,
      }),
    ).toBe("claude --resume 'abc'");
  });

  it("falls back to no-cd command when directory is whitespace-only", () => {
    // A whitespace-only directory would expand to `cd '   '` which is at best
    // confusing and at worst silently masks the missing-directory case. The
    // copy-resume button should produce a runnable command regardless of how
    // the upstream metadata happens to be filled in.
    expect(
      buildResumeCommand({
        resumeCommandPrefix: "claude --resume",
        sessionId: "abc",
        directory: "   ",
      }),
    ).toBe("claude --resume 'abc'");
    expect(
      buildResumeCommand({
        resumeCommandPrefix: "claude --resume",
        sessionId: "abc",
        directory: "\t\n",
      }),
    ).toBe("claude --resume 'abc'");
  });
});
