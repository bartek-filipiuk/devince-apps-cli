// Minimal, strict ZIP reader. No dependencies, no streaming: archives here are a few MB.
// Rejects everything an installer must never write: absolute paths, "..", backslashes, symlinks,
// unsupported compression, entries whose size or CRC does not match the central directory.
import { inflateRawSync } from "node:zlib";

export const LIMITS = { entries: 5000, entryBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export class ZipError extends Error {}

// A safe relative path: non-empty segments, no ".", "..", no separators other than "/", no control chars.
export function safeEntryName(name) {
  if (typeof name !== "string" || !name || name.length > 512) return false;
  if (name.includes("\\") || name.includes("\0") || /[\x00-\x1f]/.test(name)) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return name.split("/").every((seg, i, all) => (seg !== "" || i === all.length - 1) && seg !== "." && seg !== "..");
}

/** @returns {{name: string, dir: boolean, data?: Buffer}[]} regular files and directories only */
export function readZip(buf) {
  if (buf.length < 22) throw new ZipError("not a zip archive");
  // End of central directory: scan back over a possible comment (max 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > LIMITS.entries) throw new ZipError(`too many entries (${count})`);
  if (cdOffset + cdSize > eocd) throw new ZipError("central directory out of bounds");

  const entries = [];
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("bad central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError(`encrypted entry: ${name}`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ZipError("zip64 is not supported");
    if (!safeEntryName(name)) throw new ZipError(`unsafe entry name: ${JSON.stringify(name)}`);
    const unixMode = extAttrs >>> 16;
    const isSymlink = (unixMode & 0xf000) === 0xa000;
    if (isSymlink) throw new ZipError(`symlink entry: ${name}`);
    const dir = name.endsWith("/");
    if (dir) { entries.push({ name, dir: true }); continue; }
    if (usize > LIMITS.entryBytes) throw new ZipError(`entry too large: ${name}`);
    total += usize;
    if (total > LIMITS.totalBytes) throw new ZipError("archive too large when extracted");

    // Local header: sizes may live only here when the data descriptor flag is set; we trust the
    // central directory values and only use the local header to find the data.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError(`bad local header: ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + csize > buf.length) throw new ZipError(`entry data out of bounds: ${name}`);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: usize + 1 });
    else throw new ZipError(`unsupported compression method ${method}: ${name}`);
    if (data.length !== usize) throw new ZipError(`size mismatch: ${name}`);
    if (crc32(data) !== crc) throw new ZipError(`crc mismatch: ${name}`);
    entries.push({ name, dir: false, data });
  }
  return entries;
}
