// shared/ui.js session regressions: (1) a save still pending when the page goes away (pagehide) is
// written, and its IndexedDB transaction starts in that same task (a closing page doesn't wait for
// an await); (2) the "Continue" card frees its thumbnail's blob URL when it's drawn again.
// Run: (await import("/_test/sessiontest.js")).run()
import { session, renderResume } from "../shared/ui.js";

export async function run() {
  const T = "zz-sessiontest", out = {};
  await session.clear(T);
  await session.load(T); // the database is open, as it is on a page that has been used

  // 1. pagehide with a save pending: the save happens, and its transaction starts synchronously
  const tr = IDBDatabase.prototype.transaction;
  let started = 0;
  IDBDatabase.prototype.transaction = function (...a) { if ([a[0]].flat().includes("sessions") && a[1] === "readwrite") started++; return tr.apply(this, a); };
  try {
    session.saveSoon(T, () => ({ name: "pending", sub: "", state: { v: 1 } }), 60_000);
    dispatchEvent(new Event("pagehide"));
    out.syncTx = started > 0; // counted before anything was awaited
  } finally { IDBDatabase.prototype.transaction = tr; }
  await new Promise((r) => setTimeout(r, 300));
  out.flushed = (await session.load(T))?.name === "pending";

  // 2. the resume card drawn twice: the first thumbnail URL is revoked
  const thumb = await new Promise((r) => { const c = document.createElement("canvas"); c.width = c.height = 4; c.toBlob(r, "image/png"); });
  await session.save(T, { name: "thumb", sub: "", thumb, state: { v: 1 } });
  const made = [], freed = new Set(), mk = URL.createObjectURL, rv = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { const u = mk.call(URL, b); made.push(u); return u; };
  URL.revokeObjectURL = (u) => { freed.add(u); return rv.call(URL, u); };
  const box = document.createElement("div");
  try {
    await renderResume(box, T, () => {});
    await renderResume(box, T, () => {});
  } finally { URL.createObjectURL = mk; URL.revokeObjectURL = rv; }
  out.thumbURLs = made.length;
  out.revoked = made.length === 2 && freed.has(made[0]) && !freed.has(made[1]);
  for (const u of made) rv.call(URL, u);
  await session.clear(T);
  return { pass: out.syncTx && out.flushed && out.revoked, out };
}
