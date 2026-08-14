import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DshAgent } from "../dsh.js";

// Node 22.0–22.14 ships no native Zstandard codec, and CodeSesh keeps its
// engine floor at 22 so every other agent still works there. Removing the
// decoder proves a DSH compressed artifact fails with an actionable runtime
// diagnostic rather than a bare "not a function".
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, zstdDecompressSync: undefined };
});

const SESSION_ID = "session-runtime";
const CWD = "/tmp/project";

let dataRoot = "";

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "codesesh-dsh-runtime-"));
  vi.stubEnv("DSH_HOME", dataRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataRoot, { recursive: true, force: true });
});

function writeArtifact(fileName: string, contents: Buffer | string): void {
  const directory = join(dataRoot, "sessions", "--tmp-project--", SESSION_ID);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, fileName), contents);
}

describe("DSH without a native Zstandard decoder", () => {
  it("names the runtime DSH itself requires", () => {
    // The capability check runs before any decode, so the bytes never matter.
    writeArtifact("session.jsonl.zstd", Buffer.from("not decodable here"));

    let caught: unknown;
    try {
      new DshAgent().scan();
    } catch (error) {
      caught = error;
    }
    expect(String((caught as { cause?: unknown }).cause)).toMatch(
      /Zstandard-compressed.*no native Zstandard decoder.*22\.19\.0/s,
    );
  });

  it("still reads a plaintext artifact", () => {
    const header = {
      type: "session",
      version: 0,
      id: SESSION_ID,
      createdAt: 1_700_000_000_000,
      cwd: CWD,
      delegationDepth: 0,
    };
    const events = [
      {
        type: "user/message",
        seq: 0,
        time: 1_700_000_000_010,
        data: {
          id: "u0",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      },
      {
        type: "assistant/message",
        seq: 1,
        time: 1_700_000_000_020,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "a1",
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
          },
        },
        surfaceOp: "append",
      },
    ];
    writeArtifact(
      "session.jsonl",
      [header, ...events].map((record) => `${JSON.stringify(record)}\n`).join(""),
    );

    expect(new DshAgent().scan()[0]?.stats.message_count).toBe(2);
  });
});
