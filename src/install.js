// Puts a verified archive into ~/.claude/skills. The archive must carry devince-install.json at its
// root, which names the product and where each folder goes. Destinations are confined to
// ~/.claude/skills/<name>; existing folders are moved aside, never deleted; symlinked destinations
// are left alone unless --force (a developer's checkout usually lives behind one).
import { mkdirSync, writeFileSync, existsSync, lstatSync, renameSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { readZip, safeEntryName } from "./zip.js";

export class InstallError extends Error {}

/** The archive is a project (a starter, a template), not skills: nothing to place, the buyer unzips it. */
export class NotASkillError extends InstallError {
  constructor(entries) {
    super("the archive has no devince-install.json; it is not a product from apps.devince.dev");
    const files = entries.filter((e) => !e.dir).map((e) => e.name);
    this.readme = files.find((n) => /^([^/]+\/)?START\.md$/i.test(n)) ?? files.find((n) => /^([^/]+\/)?README\.md$/i.test(n));
  }
}

export const claudeHome = () => process.env.DEVINCE_APPS_HOME || join(homedir(), ".claude");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { throw new InstallError("devince-install.json is not valid JSON"); }
  if (!m || typeof m !== "object") throw new InstallError("devince-install.json must be an object");
  if (!NAME_RE.test(String(m.product ?? ""))) throw new InstallError("manifest: bad product name");
  if (!VERSION_RE.test(String(m.version ?? ""))) throw new InstallError("manifest: bad version");
  if (!Array.isArray(m.targets) || !m.targets.length || m.targets.length > 10) throw new InstallError("manifest: targets must list 1-10 folders");
  const targets = m.targets.map((t) => {
    const from = String(t?.from ?? "").replace(/\/+$/, "");
    const to = String(t?.to ?? "");
    if (!safeEntryName(from) || from.includes("/..")) throw new InstallError(`manifest: bad source path ${JSON.stringify(from)}`);
    const dest = to.match(/^skills\/([a-z0-9][a-z0-9-]{0,39})$/);
    if (!dest) throw new InstallError(`manifest: destination must be skills/<name>, got ${JSON.stringify(to)}`);
    return { from, name: dest[1] };
  });
  const names = new Set(targets.map((t) => t.name));
  if (names.size !== targets.length) throw new InstallError("manifest: duplicate destinations");
  return { product: m.product, version: m.version, targets };
}

/** Verifies the archive and returns what would be installed, without touching the disk. */
export function inspectArchive(buf) {
  const entries = readZip(buf);
  const manifestEntry = entries.find((e) => !e.dir && e.name === "devince-install.json")
    ?? entries.find((e) => !e.dir && /^[^/]+\/devince-install\.json$/.test(e.name));
  if (!manifestEntry) throw new NotASkillError(entries);
  // `from` paths in the manifest are relative to the archive root, wherever the manifest sits.
  const manifest = parseManifest(manifestEntry.data.toString("utf8"));
  const files = entries.filter((e) => !e.dir).map((e) => ({ name: e.name, data: e.data }));
  for (const t of manifest.targets) {
    if (!files.some((f) => f.name.startsWith(t.from + "/"))) throw new InstallError(`manifest points at a folder that is not in the archive: ${t.from}`);
  }
  return { manifest, files };
}

function writeTree(base, files, from) {
  const baseAbs = resolve(base);
  for (const f of files) {
    if (!f.name.startsWith(from + "/")) continue;
    const rel = f.name.slice(from.length + 1);
    const abs = resolve(baseAbs, rel);
    if (abs !== baseAbs && !abs.startsWith(baseAbs + sep)) throw new InstallError(`refusing to write outside the target: ${f.name}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.data, { mode: 0o644 });
  }
}

/** Installs an inspected archive. Returns the placed folders and where previous copies went. */
export function installArchive({ manifest, files }, { force = false, now = new Date() } = {}) {
  const skills = join(claudeHome(), "skills");
  mkdirSync(skills, { recursive: true });
  const placed = [];
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  for (const t of manifest.targets) {
    const dest = join(skills, t.name);
    if (existsSync(dest) || isLink(dest)) {
      if (isLink(dest) && !force) throw new InstallError(`${dest} is a symlink (a developer checkout?). Remove it or run with --force to replace the link.`);
    }
  }
  const tmp = join(skills, `.devince-tmp-${randomBytes(6).toString("hex")}`);
  try {
    for (const t of manifest.targets) writeTree(join(tmp, t.name), files, t.from);
    for (const t of manifest.targets) {
      const dest = join(skills, t.name);
      let backup = null;
      if (isLink(dest)) { rmSync(dest); }
      else if (existsSync(dest)) {
        backup = join(skills, ".devince-backup", `${t.name}-${stamp}`);
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(dest, backup);
      }
      renameSync(join(tmp, t.name), dest);
      placed.push({ name: t.name, path: dest, backup });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  recordInstall(manifest, placed, now);
  return placed;
}

/** Store-suggested name reduced to a plain file name; anything that is not a .zip gets a fixed name. */
export function archiveFileName(suggested) {
  const base = String(suggested ?? "").split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return /\.zip$/i.test(base) ? base : "devince-download.zip";
}

/** Saves a downloaded project archive into `dir` (temp dir if `dir` is not writable), never over an existing file. */
export function saveArchive(buf, suggested, dir = process.cwd()) {
  const name = archiveFileName(suggested);
  let lastError;
  for (const d of [dir, tmpdir()]) {
    for (let i = 0; i < 100; i++) {
      const path = resolve(d, i ? name.replace(/\.zip$/i, `-${i}.zip`) : name);
      try { writeFileSync(path, buf, { flag: "wx" }); return path; }
      catch (e) { lastError = e; if (e.code !== "EEXIST") break; }
    }
  }
  throw new InstallError(`could not save ${name}: ${lastError?.message}`);
}

function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

const registryPath = () => join(claudeHome(), "skills", ".devince-apps.json");
export function readRegistry() {
  try { return JSON.parse(readFileSync(registryPath(), "utf8")); } catch { return {}; }
}
function recordInstall(manifest, placed, now) {
  const reg = readRegistry();
  reg[manifest.product] = { version: manifest.version, installedAt: now.toISOString(), folders: placed.map((p) => p.name) };
  writeFileSync(registryPath(), JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
}
