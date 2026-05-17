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
        agentName: "claudecode",
        sessionId: "abc-123",
        directory: "/Users/me/project",
      }),
    ).toBe("cd '/Users/me/project' && claude --resume 'abc-123'");
  });

  it.each([
    ["claudecode", "claude --resume"],
    ["codex", "codex resume"],
    ["kimi", "kimi -r"],
    ["opencode", "opencode -s"],
  ])("emits the %s resume command", (agentName, prefix) => {
    expect(
      buildResumeCommand({
        agentName,
        sessionId: "abc-123",
        directory: "/Users/me/project",
      }),
    ).toBe(`cd '/Users/me/project' && ${prefix} 'abc-123'`);
  });

  it("does not emit a resume command for cursor", () => {
    expect(
      buildResumeCommand({
        agentName: "cursor",
        sessionId: "abc-123",
        directory: "/Users/me/project",
      }),
    ).toBeNull();
  });

  it("preserves a worktree path verbatim (no normalization away from worktree)", () => {
    // Worktree paths are typically a sibling/sub directory of the main repo.
    // The whole point of using session.directory (cwd at session start) over
    // project_identity.path_root is that worktree sessions need to resume in
    // the worktree, not the root repo — so we must pass the path through as-is.
    const cmd = buildResumeCommand({
      agentName: "claudecode",
      sessionId: "wt-1",
      directory: "/Users/me/repos/myrepo-worktrees/feature-x",
    });
    expect(cmd).toBe("cd '/Users/me/repos/myrepo-worktrees/feature-x' && claude --resume 'wt-1'");
  });

  it("shell-quotes adversarial directory containing a single quote", () => {
    const cmd = buildResumeCommand({
      agentName: "claudecode",
      sessionId: "id-1",
      directory: "/tmp/can't escape",
    });
    // The directory's literal ' is escaped via '\''; the shell sees: /tmp/can't escape
    expect(cmd).toBe("cd '/tmp/can'\\''t escape' && claude --resume 'id-1'");
  });

  it("shell-quotes adversarial sessionId", () => {
    const cmd = buildResumeCommand({
      agentName: "claudecode",
      sessionId: "x'; rm -rf /tmp/__bad",
      directory: "/tmp/proj",
    });
    expect(cmd).toBe("cd '/tmp/proj' && claude --resume 'x'\\''; rm -rf /tmp/__bad'");
  });

  it("falls back to no-cd command when directory is missing", () => {
    expect(buildResumeCommand({ agentName: "claudecode", sessionId: "abc" })).toBe(
      "claude --resume 'abc'",
    );
    expect(buildResumeCommand({ agentName: "claudecode", sessionId: "abc", directory: null })).toBe(
      "claude --resume 'abc'",
    );
    expect(
      buildResumeCommand({ agentName: "claudecode", sessionId: "abc", directory: undefined }),
    ).toBe("claude --resume 'abc'");
  });

  it("falls back to no-cd command with the agent-specific resume syntax", () => {
    expect(buildResumeCommand({ agentName: "codex", sessionId: "abc" })).toBe("codex resume 'abc'");
    expect(buildResumeCommand({ agentName: "kimi", sessionId: "abc" })).toBe("kimi -r 'abc'");
    expect(buildResumeCommand({ agentName: "opencode", sessionId: "abc" })).toBe(
      "opencode -s 'abc'",
    );
  });

  it("falls back to no-cd command when directory is whitespace-only", () => {
    // A whitespace-only directory would expand to `cd '   '` which is at best
    // confusing and at worst silently masks the missing-directory case. The
    // copy-resume button should produce a runnable command regardless of how
    // the upstream metadata happens to be filled in.
    expect(
      buildResumeCommand({ agentName: "claudecode", sessionId: "abc", directory: "   " }),
    ).toBe("claude --resume 'abc'");
    expect(
      buildResumeCommand({ agentName: "claudecode", sessionId: "abc", directory: "\t\n" }),
    ).toBe("claude --resume 'abc'");
  });

  it("preserves surrounding whitespace inside a non-empty directory", () => {
    // If the upstream cwd happens to carry trailing/leading whitespace (rare
    // but possible from dirty metadata), we must NOT silently strip it — that
    // would emit a `cd` to a different path than what the session was started
    // from. trim() is for emptiness detection only; the quoted argument stays
    // verbatim.
    expect(
      buildResumeCommand({
        agentName: "claudecode",
        sessionId: "abc",
        directory: " /tmp/proj ",
      }),
    ).toBe("cd ' /tmp/proj ' && claude --resume 'abc'");
    expect(
      buildResumeCommand({
        agentName: "claudecode",
        sessionId: "abc",
        directory: "\t/var/log/app",
      }),
    ).toBe("cd '\t/var/log/app' && claude --resume 'abc'");
  });
});
