import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

export function normalizeMainArchive(path) {
  const archive = gunzipSync(readFileSync(path));
  let launchers = 0;
  let offset = 0;
  for (; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const octal = (start, end) => {
      const value = text(start, end).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar numeric field in ${path}`);
      return Number.parseInt(value, 8);
    };
    const checksum = [...header].reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== octal(148, 156)) throw new Error(`Invalid tar checksum in ${path}`);
    const size = octal(124, 136);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > archive.length)
      throw new Error(`Truncated tar entry in ${path}`);
    if (text(0, 100) === "package/bin/codesesh.cjs") {
      if (text(345, 500) !== "" || ![0, 48].includes(header[156]))
        throw new Error(`Unexpected launcher tar entry in ${path}`);
      // Windows chmod cannot persist Unix execute bits; npm packs this launcher as 0644.
      header.write("0000755\0", 100, 8, "ascii");
      header.fill(32, 148, 156);
      const updated = [...header].reduce((sum, byte) => sum + byte, 0);
      header.write(`${updated.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
      launchers++;
    }
    offset = next;
  }
  if (launchers !== 1 || archive.length - offset < 1024 || archive.subarray(offset).some(Boolean))
    throw new Error(`Invalid main package tar structure in ${path}`);
  const compressed = gzipSync(archive, { level: 9 });
  // The gzip OS header must be identical across publishing hosts.
  compressed[9] = 255;
  writeFileSync(path, compressed);
}
