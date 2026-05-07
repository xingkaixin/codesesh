import { describe, expect, it } from "vitest";
import { buildResumeCommand, shellQuote } from "./build-resume-command";

describe("shellQuote", () => {
  it("wraps simple values in single quotes", () => {
    expect(shellQuote("abc")).toBe("'abc'");
  });

  it("escapes embedded single quotes the POSIX way ('\\'') so the shell sees one literal '", () => {
    // 'x'\''y' bash-decodes to: x'y. Using string concat to keep this readable
    // and avoid ambiguous escaping in the source.
    expect(shellQuote("x'y")).toBe("'x'\\''y'");
  });

  it("treats empty string as a quoted empty arg (does not collapse)", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("does not need to escape spaces or shell metacharacters — single-quoting handles them", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
    expect(shellQuote("a; rm -rf /")).toBe("'a; rm -rf /'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
  });
});

describe("buildResumeCommand", () => {
  it("emits cd && claude --resume when directory is present", () => {
    expect(
      buildResumeCommand({
        sessionId: "abc-123",
        directory: "/Users/me/project",
      }),
    ).toBe("cd '/Users/me/project' && claude --resume 'abc-123'");
  });

  it("preserves a worktree path verbatim (no normalization away from worktree)", () => {
    // Worktree paths are typically a sibling/sub directory of the main repo.
    // The whole point of using session.directory (cwd at session start) over
    // project_identity.path_root is that worktree sessions need to resume in
    // the worktree, not the root repo — so we must pass the path through as-is.
    const cmd = buildResumeCommand({
      sessionId: "wt-1",
      directory: "/Users/me/repos/myrepo-worktrees/feature-x",
    });
    expect(cmd).toBe(
      "cd '/Users/me/repos/myrepo-worktrees/feature-x' && claude --resume 'wt-1'",
    );
  });

  it("shell-quotes adversarial directory containing a single quote", () => {
    const cmd = buildResumeCommand({
      sessionId: "id-1",
      directory: "/tmp/can't escape",
    });
    // The directory's literal ' is escaped via '\''; the shell sees: /tmp/can't escape
    expect(cmd).toBe("cd '/tmp/can'\\''t escape' && claude --resume 'id-1'");
  });

  it("shell-quotes adversarial sessionId", () => {
    const cmd = buildResumeCommand({
      sessionId: "x'; rm -rf /tmp/__bad",
      directory: "/tmp/proj",
    });
    expect(cmd).toBe("cd '/tmp/proj' && claude --resume 'x'\\''; rm -rf /tmp/__bad'");
  });

  it("falls back to no-cd command when directory is missing", () => {
    expect(buildResumeCommand({ sessionId: "abc" })).toBe("claude --resume 'abc'");
    expect(buildResumeCommand({ sessionId: "abc", directory: null })).toBe(
      "claude --resume 'abc'",
    );
    expect(buildResumeCommand({ sessionId: "abc", directory: undefined })).toBe(
      "claude --resume 'abc'",
    );
  });

  it("falls back to no-cd command when directory is whitespace-only", () => {
    // A whitespace-only directory would expand to `cd '   '` which is at best
    // confusing and at worst silently masks the missing-directory case. The
    // copy-resume button should produce a runnable command regardless of how
    // the upstream metadata happens to be filled in.
    expect(buildResumeCommand({ sessionId: "abc", directory: "   " })).toBe(
      "claude --resume 'abc'",
    );
    expect(buildResumeCommand({ sessionId: "abc", directory: "\t\n" })).toBe(
      "claude --resume 'abc'",
    );
  });
});
