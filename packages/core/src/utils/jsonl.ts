import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const READ_CHUNK_BYTES = 1 << 20;

export function* parseJsonlLines(content: string): Generator<Record<string, unknown>> {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Skip malformed lines
    }
  }
}

/**
 * Streams trimmed non-empty lines chunk by chunk so a session log is never
 * held in memory at once. Codex rollout files can exceed 400 MB; loading them
 * with readFileSync + split doubles that as UTF-16 strings and OOMs the
 * scan-refresh worker.
 */
export function* readJsonlFileLines(
  filePath: string,
  chunkBytes = READ_CHUNK_BYTES,
): Generator<string> {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(chunkBytes);
    // StringDecoder buffers multi-byte UTF-8 sequences split across chunks.
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let bytesRead = readSync(fd, buffer, 0, chunkBytes, -1);
    while (bytesRead > 0) {
      const lines = (remainder + decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      remainder = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
      bytesRead = readSync(fd, buffer, 0, chunkBytes, -1);
    }
    const tail = (remainder + decoder.end()).trim();
    if (tail) yield tail;
  } finally {
    closeSync(fd);
  }
}

export function* readJsonlFile(filePath: string): Generator<Record<string, unknown>> {
  for (const line of readJsonlFileLines(filePath)) {
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Skip malformed lines
    }
  }
}
