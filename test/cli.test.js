import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readZip, ZipError, safeEntryName } from "../src/zip.js";
import { inspectArchive, installArchive, parseManifest, InstallError, readRegistry, NotASkillError, archiveFileName, saveArchive } from "../src/install.js";
import { downloadUrlFrom, StoreError, waitForGrant, maskToken, downloadArchive } from "../src/store.js";
import { buildZip, productZip, manifest } from "./zipwriter.js";

const home = () => { const d = mkdtempSync(join(tmpdir(), "devince-apps-")); process.env.DEVINCE_APPS_HOME = d; return d; };

test("zip reader accepts a normal archive and checks crc and sizes", () => {
  const entries = readZip(productZip());
  assert.equal(entries.filter((e) => !e.dir).length, 5);
  assert.equal(entries.find((e) => e.name === "security-audit/SKILL.md").data.toString(), "# skill\n");
  assert.throws(() => readZip(buildZip([{ name: "a.txt", data: "x", badCrc: true }])), /crc mismatch/);
  assert.throws(() => readZip(buildZip([{ name: "a.txt", data: "x", badSize: true }])), /size mismatch/);
  assert.throws(() => readZip(Buffer.from("not a zip at all, really")), /not a zip/);
});

test("zip reader rejects traversal, absolute paths, backslashes, symlinks and encrypted entries", () => {
  for (const name of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a/./b"]) {
    assert.throws(() => readZip(buildZip([{ name, data: "x" }])), ZipError, name);
    assert.equal(safeEntryName(name), false, name);
  }
  assert.throws(() => readZip(buildZip([{ name: "a/link", data: "/etc/passwd", mode: 0o120777 }])), /symlink/);
  assert.throws(() => readZip(buildZip([{ name: "a.txt", data: "x", flags: 0x1 }])), /encrypted/);
});

test("manifest is validated strictly", () => {
  assert.throws(() => parseManifest("{"), /valid JSON/);
  assert.throws(() => parseManifest(manifest({ product: "../x" })), /product name/);
  assert.throws(() => parseManifest(manifest({ version: "1" })), /version/);
  assert.throws(() => parseManifest(manifest({ targets: [{ from: "a", to: "../../.ssh" }] })), /destination/);
  assert.throws(() => parseManifest(manifest({ targets: [{ from: "a", to: "skills/x" }, { from: "b", to: "skills/x" }] })), /duplicate/);
  assert.throws(() => inspectArchive(buildZip([{ name: "x/SKILL.md", data: "" }])), /no devince-install.json/);
  assert.throws(() => inspectArchive(productZip([], { targets: [{ from: "missing", to: "skills/missing" }] })), /not in the archive/);
});

test("install places both folders, backs up a previous copy and refuses a symlink unless forced", () => {
  const h = home();
  const inspected = inspectArchive(productZip());
  const placed = installArchive(inspected, { now: new Date("2026-10-03T10:00:00Z") });
  assert.deepEqual(placed.map((p) => p.name), ["security-audit", "audit-live"]);
  assert.ok(existsSync(join(h, "skills/security-audit/SKILL.md")));
  assert.ok(existsSync(join(h, "skills/audit-live/hooks/register.js")));
  assert.equal(readFileSync(join(h, "skills/security-audit/scripts/a.mjs"), "utf8"), "export const a = 1;\n");
  assert.equal(readRegistry()["security-audit"].version, "1.1.0");
  assert.ok(!readdirSync(join(h, "skills")).some((n) => n.startsWith(".devince-tmp")), "no temp dir left");

  // second install: previous copy moved aside, not deleted
  const again = installArchive(inspectArchive(productZip([], { version: "1.2.0" })), { now: new Date("2026-10-04T10:00:00Z") });
  assert.ok(again[0].backup && existsSync(join(again[0].backup, "SKILL.md")));
  assert.equal(readRegistry()["security-audit"].version, "1.2.0");

  // symlinked destination (developer checkout) is refused, then replaced with --force
  const h2 = home();
  mkdirSync(join(h2, "skills"), { recursive: true });
  mkdirSync(join(h2, "checkout"));
  symlinkSync(join(h2, "checkout"), join(h2, "skills/security-audit"));
  assert.throws(() => installArchive(inspectArchive(productZip())), InstallError);
  assert.ok(!existsSync(join(h2, "skills/audit-live")), "nothing written when refused");
  installArchive(inspectArchive(productZip()), { force: true });
  assert.ok(!lstatSync(join(h2, "skills/security-audit")).isSymbolicLink());
  assert.ok(existsSync(join(h2, "checkout")), "the link target is untouched");
});

test("download links are normalised and anything off-store is refused", () => {
  const t = "abcdefghij.0123456789abcdef0123";
  assert.equal(downloadUrlFrom(`https://apps.devince.dev/download/${t}`), `https://apps.devince.dev/api/apps/download/${t}`);
  assert.equal(downloadUrlFrom(`https://apps.devince.dev/api/apps/download/${t}?file=27`), `https://apps.devince.dev/api/apps/download/${t}?file=27`);
  assert.equal(downloadUrlFrom(t), `https://apps.devince.dev/api/apps/download/${t}`);
  for (const bad of ["http://apps.devince.dev/download/" + t, "https://apps.devince.dev.evil.com/download/" + t, "https://evil.com/download/" + t, "https://apps.devince.dev/other/" + t, "javascript:alert(1)"]) {
    assert.throws(() => downloadUrlFrom(bad), StoreError, bad);
  }
  assert.doesNotMatch(maskToken(`https://apps.devince.dev/api/apps/download/${t}`), new RegExp(t));
});

test("waitForGrant polls, tolerates 429 and gives up on time", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url) => { calls.push(String(url)); n++; return new Response(JSON.stringify(n < 3 ? { ready: false } : { ready: true, token: "abcdefghij.0123456789abcdef0123" }), { status: n === 1 ? 429 : 200, headers: { "content-type": "application/json" } }); };
  try {
    const token = await waitForGrant("cs_test_abcdefghijklmnop", { intervalMs: 1, sleep: async () => {} });
    assert.equal(token, "abcdefghij.0123456789abcdef0123");
    assert.ok(calls.every((c) => c.startsWith("https://apps.devince.dev/api/apps/session-grant?session_id=cs_test_")));
    n = -1000;
    const none = await waitForGrant("cs_test_abcdefghijklmnop", { intervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.equal(none, null);
  } finally { globalThis.fetch = realFetch; }
});

test("a project archive (no manifest) is recognised and saved next to the buyer, never over a file", async () => {
  const zip = buildZip([{ name: "page-boilerplate/" }, { name: "page-boilerplate/README.md", data: "r" }, { name: "page-boilerplate/START.md", data: "s" }]);
  const err = (() => { try { inspectArchive(zip); } catch (e) { return e; } })();
  assert.ok(err instanceof NotASkillError);
  assert.equal(err.readme, "page-boilerplate/START.md");

  for (const [given, want] of [["starter-v11.zip", "starter-v11.zip"], ["../../.bashrc.zip", "bashrc.zip"], ["a\\b c.zip", "a_b_c.zip"], ["x.sh", "devince-download.zip"], [undefined, "devince-download.zip"]]) {
    assert.equal(archiveFileName(given), want, String(given));
  }
  const dir = mkdtempSync(join(tmpdir(), "devince-apps-save-"));
  const first = saveArchive(zip, "../starter-v11.zip", dir);
  const second = saveArchive(Buffer.from("other"), "starter-v11.zip", dir);
  assert.equal(first, join(dir, "starter-v11.zip"));
  assert.equal(second, join(dir, "starter-v11-1.zip"));
  assert.deepEqual(readFileSync(first), zip, "first copy untouched");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(zip, { status: 200, headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="starter-strona-firmowa-v11.zip"' } });
  try {
    const got = await downloadArchive("https://apps.devince.dev/api/apps/download/abcdefghij.0123456789abcdef0123");
    assert.equal(got.filename, "starter-strona-firmowa-v11.zip");
    assert.deepEqual(got.data, zip);
  } finally { globalThis.fetch = realFetch; }
});
