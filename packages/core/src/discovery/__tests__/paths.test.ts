import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => "/home/testuser"),
    platform: vi.fn(() => "darwin"),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

import { homedir, platform } from "node:os";
import { existsSync } from "node:fs";
import "../../agents/register.js";
import { resolveAgentRoots } from "../../agents/registry.js";

/** Normalize path separators so tests work on both Unix and Windows */
const expectPath = (actual: string) => expect(actual.replace(/\\/g, "/"));

const mockedHomedir = vi.mocked(homedir);
const mockedPlatform = vi.mocked(platform);
const mockedExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("KIMI_SHARE_DIR", undefined);
  vi.stubEnv("PI_HOME", undefined);
  vi.stubEnv("CURSOR_DATA_PATH", undefined);
  vi.stubEnv("XDG_DATA_HOME", undefined);
  vi.stubEnv("LOCALAPPDATA", undefined);
  vi.stubEnv("APPDATA", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAgentRoots", () => {
  it("uses default paths when no env vars are set", () => {
    mockedHomedir.mockReturnValue("/home/user");
    const roots = resolveAgentRoots();
    expectPath(roots.codex!).toBe("/home/user/.codex");
    expectPath(roots.claudecode!).toBe("/home/user/.claude");
    expectPath(roots.kimi!).toBe("/home/user/.kimi");
    expectPath(roots.pi!).toBe("/home/user/.pi");
    expectPath(roots.zcode!).toBe("/home/user/.zcode");
  });

  it("respects CODEX_HOME override", () => {
    vi.stubEnv("CODEX_HOME", "/custom/codex");
    mockedHomedir.mockReturnValue("/home/user");
    const roots = resolveAgentRoots();
    expectPath(roots.codex!).toBe("/custom/codex");
  });

  it("respects CLAUDE_CONFIG_DIR override", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/custom/claude");
    mockedHomedir.mockReturnValue("/home/user");
    const roots = resolveAgentRoots();
    expectPath(roots.claudecode!).toBe("/custom/claude");
  });

  it("respects KIMI_SHARE_DIR override", () => {
    vi.stubEnv("KIMI_SHARE_DIR", "/custom/kimi");
    mockedHomedir.mockReturnValue("/home/user");
    const roots = resolveAgentRoots();
    expectPath(roots.kimi!).toBe("/custom/kimi");
  });

  it("respects PI_HOME override", () => {
    vi.stubEnv("PI_HOME", "/custom/pi");
    mockedHomedir.mockReturnValue("/home/user");
    const roots = resolveAgentRoots();
    expectPath(roots.pi!).toBe("/custom/pi");
  });

  it("computes the OpenCode root from the data home", () => {
    mockedHomedir.mockReturnValue("/home/user");
    mockedPlatform.mockReturnValue("linux");
    vi.stubEnv("XDG_DATA_HOME", "/custom/data");
    const roots = resolveAgentRoots();
    expectPath(roots.opencode!).toBe("/custom/data/opencode");
  });
});

describe("Cursor data root", () => {
  it("returns CURSOR_DATA_PATH when set", () => {
    vi.stubEnv("CURSOR_DATA_PATH", "/custom/cursor");
    expect(resolveAgentRoots().cursor).toBe("/custom/cursor");
  });

  it("returns darwin path when it exists", () => {
    mockedPlatform.mockReturnValue("darwin");
    mockedHomedir.mockReturnValue("/home/user");
    mockedExistsSync.mockReturnValue(true);
    const result = resolveAgentRoots().cursor;
    expectPath(result!).toContain("Cursor");
    expectPath(result!).toContain("User");
  });

  it("returns linux path when it exists", () => {
    mockedPlatform.mockReturnValue("linux");
    mockedHomedir.mockReturnValue("/home/user");
    mockedExistsSync.mockReturnValue(true);
    vi.stubEnv("XDG_CONFIG_HOME", "/home/user/.config");
    const result = resolveAgentRoots().cursor;
    expectPath(result!).toContain("Cursor");
  });

  it("returns null when no path exists", () => {
    mockedPlatform.mockReturnValue("darwin");
    mockedExistsSync.mockReturnValue(false);
    expect(resolveAgentRoots().cursor).toBeNull();
  });
});

describe("ZCode data root", () => {
  it("returns the macOS ZCode root", () => {
    mockedPlatform.mockReturnValue("darwin");
    mockedHomedir.mockReturnValue("/home/user");
    expectPath(resolveAgentRoots().zcode!).toBe("/home/user/.zcode");
  });

  it("returns the Windows ZCode root", () => {
    mockedPlatform.mockReturnValue("win32");
    mockedHomedir.mockReturnValue("/home/user");
    expectPath(resolveAgentRoots().zcode!).toBe("/home/user/.zcode");
  });

  it("does not probe a Linux default path", () => {
    mockedPlatform.mockReturnValue("linux");
    expect(resolveAgentRoots().zcode).toBeNull();
  });
});
