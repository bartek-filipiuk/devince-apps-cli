// Everything that talks to the store. Only https, only these hosts, redirects followed only inside
// the allowlist, bodies capped. Nothing here prints a token.
import { Buffer } from "node:buffer";

export const STORE = "https://apps.devince.dev";
const ALLOWED_HOSTS = new Set(["apps.devince.dev", "devince.dev"]);
const MAX_BODY = 64 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}\.[0-9a-f]{16,128}$/;
const SESSION_RE = /cs_(?:live|test)_[A-Za-z0-9]{10,200}/;

// Product aliases for `buy`: short name on the left, store slug on the right.
export const PRODUCTS = {};

export class StoreError extends Error {}

export function assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new StoreError(`refusing to talk to ${u.origin}`);
  return u;
}

/** Turns what a buyer pastes (e-mail link, API link or bare token) into the API download URL. */
export function downloadUrlFrom(input) {
  const s = String(input).trim();
  if (TOKEN_RE.test(s)) return `${STORE}/api/apps/download/${s}`;
  let u;
  try { u = assertAllowed(s); } catch (e) { throw new StoreError("expected the download link from the e-mail (https://apps.devince.dev/download/…)"); }
  const m = u.pathname.match(/^\/(?:api\/apps\/)?download\/([^/]+)\/?$/);
  if (!m || !TOKEN_RE.test(m[1])) throw new StoreError("that is not a download link from apps.devince.dev");
  const file = u.searchParams.get("file");
  return `${STORE}/api/apps/download/${m[1]}${file && /^\d{1,9}$/.test(file) ? `?file=${file}` : ""}`;
}

export function maskToken(url) {
  return String(url).replace(/download\/([^/?]{4})[^/?]*/, "download/$1…");
}

async function request(url, init = {}, hops = 0) {
  assertAllowed(url);
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (hops >= 3) throw new StoreError("too many redirects");
    const loc = res.headers.get("location");
    if (!loc) throw new StoreError("redirect without location");
    const next = new URL(loc, url).toString();
    return request(next, init.method === "POST" && res.status !== 307 && res.status !== 308 ? { ...init, method: "GET", body: undefined } : init, hops + 1);
  }
  return res;
}

async function readCapped(res, max = MAX_BODY) {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new StoreError("download larger than allowed");
  const chunks = [];
  let n = 0;
  for await (const chunk of res.body) {
    n += chunk.length;
    if (n > max) throw new StoreError("download larger than allowed");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Downloads the archive behind a grant. 403 means the link is invalid, expired or used up. */
export async function downloadArchive(url) {
  const res = await request(url, { headers: { accept: "application/zip, application/octet-stream" }, timeoutMs: 120_000 });
  if (res.status === 403) throw new StoreError("the store refused this link: it is invalid, expired (7 days) or used up (5 downloads). Ask for a new one.");
  if (res.status === 400) throw new StoreError("this product has several files; add ?file=<id> from the download page link");
  if (!res.ok) throw new StoreError(`store answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/zip|octet-stream/.test(type)) throw new StoreError(`expected a zip, got ${type || "no content type"}`);
  return readCapped(res);
}

/** Creates a checkout session. `consent` must be the buyer's explicit yes, recorded by the caller. */
export async function createCheckout({ slug, consent, locale = "pl" }) {
  if (consent !== true) throw new StoreError("consent is required before checkout");
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new StoreError("bad product slug");
  const res = await request(`${STORE}/api/apps/checkout`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ slug, consent: true, locale }),
  });
  if (res.status === 404) throw new StoreError(`no product "${slug}" in the store`);
  if (!res.ok) throw new StoreError(`checkout failed (${res.status})`);
  const { url } = await res.json();
  const u = new URL(String(url));
  if (u.protocol !== "https:" || !/(^|\.)stripe\.com$/.test(u.hostname)) throw new StoreError("unexpected checkout url");
  const sessionId = (u.pathname + u.hash).match(SESSION_RE)?.[0];
  if (!sessionId) throw new StoreError("checkout url without a session id");
  return { url: u.toString(), sessionId };
}

/** Polls until the webhook has created the grant. Returns the download token or null on timeout. */
export async function waitForGrant(sessionId, { intervalMs = 12_000, timeoutMs = 20 * 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(`${STORE}/api/apps/session-grant?session_id=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = await res.json();
      if (body.ready && typeof body.token === "string" && TOKEN_RE.test(body.token)) return body.token;
    } else if (res.status !== 429) {
      throw new StoreError(`store answered ${res.status} while waiting for the payment`);
    }
    onTick?.();
    await sleep(intervalMs);
  }
  return null;
}
