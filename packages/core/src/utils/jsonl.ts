import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { getCoreDiagnostics } from "./diagnostics.js";

const READ_CHUNK_BYTES = 1 << 20;

export function* parseJsonlLines(content: string): Generator<Record<string, unknown>> {
  let total = 0;
  let skipped = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total += 1;
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      skipped += 1;
    }
  }
  // Reported after the generator is fully drained — a consumer that breaks
  // out of the loop early (e.g. to grab just the first line) never reaches
  // this point, so its skipped count goes unreported.
  if (skipped > 0) {
    getCoreDiagnostics()?.warn("agent.jsonl_lines_skipped", { skipped, total });
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
    // Chunks of the record currently being assembled, joined once when its line
    // break arrives. Concatenating onto a string instead would re-copy the whole
    // partial record on every chunk — quadratic on the multi-megabyte single-line
    // records agent logs routinely contain.
    let pending: string[] = [];
    let bytesRead = readSync(fd, buffer, 0, chunkBytes, -1);
    while (bytesRead > 0) {
      const decoded = decoder.write(buffer.subarray(0, bytesRead));
      const lastBreak = decoded.lastIndexOf("\n");
      if (lastBreak === -1) {
        if (decoded) pending.push(decoded);
      } else {
        pending.push(decoded.slice(0, lastBreak));
        const complete = pending.join("");
        pending = [decoded.slice(lastBreak + 1)];
        for (const line of complete.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) yield trimmed;
        }
      }
      bytesRead = readSync(fd, buffer, 0, chunkBytes, -1);
    }
    pending.push(decoder.end());
    const tail = pending.join("").trim();
    if (tail) yield tail;
  } finally {
    closeSync(fd);
  }
}

export function* readJsonlFile(filePath: string): Generator<Record<string, unknown>> {
  let total = 0;
  let skipped = 0;
  for (const line of readJsonlFileLines(filePath)) {
    total += 1;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped += 1;
    }
  }
  // Same early-return caveat as parseJsonlLines above.
  if (skipped > 0) {
    getCoreDiagnostics()?.warn("agent.jsonl_lines_skipped", { skipped, total, filePath });
  }
}
