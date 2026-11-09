// shared/ui.js Recent list: drawing it again, or removing one entry, frees the thumbnail blob URLs it made.
// Run: (await import("/_test/recentstest.js")).run()
import { recents, renderRecents } from "../shared/ui.js";

export async function run() {
  const T = "zz-recentstest", out = {};
  const thumb = await new Promise((r) => { const c = document.createElement("canvas"); c.width = c.height = 4; c.toBlob(r, "image/png"); });
  const files = [1, 2].map((i) => new File([new Uint8Array(i)], `t${i}.png`, { type: "image/png", lastModified: i }));
  for (const f of files) await recents.add(T, { file: f, thumb, sub: "" });
  const made = [], freed = new Set(), mk = URL.createObjectURL, rv = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { const u = mk.call(URL, b); made.push(u); return u; };
  URL.revokeObjectURL = (u) => { freed.add(u); return rv.call(URL, u); };
  const box = document.createElement("section");
  box.innerHTML = `<div class="grid"></div>`;
  try {
    await renderRecents(box, T, () => {});
    const first = made.slice();
    await renderRecents(box, T, () => {});
    out.made = made.length;
    out.redrawFrees = first.length === 2 && first.every((u) => freed.has(u)) && !made.slice(2).some((u) => freed.has(u));
    // remove one: its URL is freed, the other stays
    const x = box.querySelector(".recent-x");
    x.click();
    await new Promise((r) => setTimeout(r, 200));
    out.removeFrees = made.slice(2).filter((u) => freed.has(u)).length === 1;
  } finally { URL.createObjectURL = mk; URL.revokeObjectURL = rv; }
  for (const u of made) rv.call(URL, u);
  for (const r of await recents.list(T)) await recents.remove(r.id);
  return { pass: !!(out.redrawFrees && out.removeFrees), out };
}
