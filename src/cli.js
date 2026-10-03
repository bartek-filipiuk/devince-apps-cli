#!/usr/bin/env node
// devince-apps: install what you bought on apps.devince.dev into Claude Code.
//   npx devince-apps install <link from the e-mail>
//   npx devince-apps buy security-audit        (add --agree when there is no terminal to answer in)
//   npx devince-apps claim <session id>
//   npx devince-apps status
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { downloadUrlFrom, downloadArchive, maskToken, createCheckout, waitForGrant, PRODUCTS, StoreError } from "./store.js";
import { inspectArchive, installArchive, readRegistry, claudeHome, InstallError } from "./install.js";
import { ZipError } from "./zip.js";

const CONSENT = "Wyrażam zgodę na natychmiastowe rozpoczęcie dostarczania treści cyfrowej (pobranie pliku) i przyjmuję do wiadomości, że z chwilą wykonania umowy (udostępnienia pliku) tracę prawo odstąpienia od umowy. Regulamin: https://devince.dev/regulamin";

const out = (s = "") => process.stdout.write(s + "\n");

function usage() {
  out(`devince-apps

  install <link>   download the product behind an e-mail link and put it in ${claudeHome()}/skills
  buy <product>    open the checkout, wait for the payment, then install (${Object.keys(PRODUCTS).join(", ")})
  claim <session>  finish a purchase started with buy (the id is printed by buy)
  status           list what is installed

  options: --agree   accept the digital-content consent printed by buy, for non-interactive runs
           --force   replace a symlinked destination (developer checkouts)`);
}

async function install(input, { force }) {
  let buf;
  if (/\.zip$/i.test(input) && existsSync(input)) {
    buf = readFileSync(input); // a local archive, for testing a package before it is uploaded
  } else {
    const url = downloadUrlFrom(input);
    out(`Downloading ${maskToken(url)}`);
    buf = await downloadArchive(url);
  }
  const inspected = inspectArchive(buf);
  const { manifest } = inspected;
  out(`Verified archive: ${manifest.product} ${manifest.version}, ${inspected.files.length} files`);
  const placed = installArchive(inspected, { force });
  for (const p of placed) out(`  ${p.path}${p.backup ? `  (previous copy moved to ${p.backup})` : ""}`);
  out(`\nDone. In Claude Code, type /${manifest.product}. A running session needs a restart to see new skills.`);
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}

const SESSION_ID_RE = /^cs_(?:live|test)_[A-Za-z0-9]{10,200}$/;
const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Non-interactive runs (Claude Code's `!`, CI, pipes) get a short wait and a `claim` command to finish later. */
async function finish(sessionId, { force }) {
  const tty = interactive();
  const token = await waitForGrant(sessionId, tty ? { onTick: () => process.stdout.write(".") } : { intervalMs: 12_000, timeoutMs: 70_000 });
  if (tty) out();
  if (!token) {
    out(tty
      ? "No payment seen in 20 minutes. If you did pay, use the link from the e-mail: npx devince-apps install <link>"
      : `Payment not confirmed yet. After paying, run:\n  npx devince-apps claim ${sessionId}\nThe download link also arrives by e-mail: npx devince-apps install <link>`);
    return 3;
  }
  await install(token, { force });
  return 0;
}

async function buy(name, { force, agree }) {
  const slug = PRODUCTS[name] ?? name;
  out(`Product: https://apps.devince.dev/${slug}\n\n${CONSENT}\n`);
  if (!agree) {
    if (!interactive()) { out(`Not a terminal, so I cannot ask. If you agree, run:\n  npx devince-apps buy ${name} --agree`); return 2; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Do you agree? Type yes to continue: ")).trim().toLowerCase();
      if (answer !== "yes" && answer !== "tak") { out("Stopped; nothing was bought."); return 2; }
    } finally { rl.close(); }
  }
  const { url, sessionId } = await createCheckout({ slug, consent: true });
  out(`\nOpening the payment page. If no browser appears, open this link:\n${url}\n`);
  openBrowser(url);
  out(interactive() ? "Waiting for the payment (up to 20 minutes). The download link also goes to your e-mail." : "Waiting about a minute for the payment.");
  return finish(sessionId, { force });
}

async function claim(sessionId, { force }) {
  if (!SESSION_ID_RE.test(sessionId)) { out("Error: that is not a checkout session id (cs_live_…)"); return 1; }
  out("Checking the payment…");
  return finish(sessionId, { force });
}

function status() {
  const reg = readRegistry();
  const names = Object.keys(reg);
  if (!names.length) { out(`Nothing installed by devince-apps in ${claudeHome()}/skills`); return; }
  for (const n of names) out(`${n} ${reg[n].version}  (${reg[n].installedAt.slice(0, 10)}; ${reg[n].folders.join(", ")})`);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const agree = args.includes("--agree");
const [cmd, arg] = args.filter((a) => !a.startsWith("--"));
try {
  if (cmd === "install" && arg) await install(arg, { force });
  else if (cmd === "buy" && arg) process.exitCode = await buy(arg, { force, agree });
  else if (cmd === "claim" && arg) process.exitCode = await claim(arg, { force });
  else if (cmd === "status") status();
  else { usage(); process.exitCode = cmd ? 1 : 0; }
} catch (e) {
  if (e instanceof StoreError || e instanceof InstallError || e instanceof ZipError) { out(`Error: ${e.message}`); process.exitCode = 1; }
  else if (e?.name === "TimeoutError" || e?.name === "AbortError") { out("Error: the store did not answer in time"); process.exitCode = 1; }
  else throw e;
}
