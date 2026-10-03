// Tiny zip writer for tests: enough to build valid archives and deliberately broken ones.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/zip.js";

export function buildZip(entries, { tamper } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.store ? 0 : 8;
    const comp = method ? deflateRawSync(data) : data;
    const crc = e.badCrc ? (crc32(data) ^ 0xff) >>> 0 : crc32(data);
    const usize = e.badSize ? data.length + 1 : data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags ?? 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? (e.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...locals, cd, eocd]);
  if (tamper) tamper(buf);
  return buf;
}

export const manifest = (over = {}) => JSON.stringify({ product: "security-audit", version: "1.1.0", targets: [{ from: "security-audit", to: "skills/security-audit" }, { from: "security-audit/audit-live", to: "skills/audit-live" }], ...over });

export function productZip(extra = [], over = {}) {
  return buildZip([
    { name: "security-audit/" },
    { name: "security-audit/devince-install.json", data: manifest(over) },
    { name: "security-audit/SKILL.md", data: "# skill\n" },
    { name: "security-audit/scripts/a.mjs", data: "export const a = 1;\n", store: true },
    { name: "security-audit/audit-live/.claude-plugin/plugin.json", data: "{}" },
    { name: "security-audit/audit-live/hooks/register.js", data: "export function register() {}" },
    ...extra,
  ]);
}
