// color/color.js Recent list: drawing it again, or removing one entry, frees the thumbnail blob URLs it made.
// Run: (await import("/_test/colorrecentstest.js")).run()
import { recents } from "../shared/ui.js";
import { mount } from "../color/color.js";

export async function run() {
  const T = "color", out = {};
  const thumb = await new Promise((r) => { const c = document.createElement("canvas"); c.width = c.height = 4; c.toBlob(r, "image/png"); });
  const files = [1, 2].map((i) => new File([new Uint8Array(i)], `zz-colortest${i}.png`, { type: "image/png", lastModified: i }));
  for (const f of files) await recents.add(T, { file: f, thumb, sub: "" });
  const made = [], freed = new Set(), mk = URL.createObjectURL, rv = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { const u = mk.call(URL, b); made.push(u); return u; };
  URL.revokeObjectURL = (u) => { freed.add(u); return rv.call(URL, u); };
  const root = document.createElement("section");
  document.body.append(root);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const m = mount(root);
    await wait(500);
    const first = made.filter((u) => u.startsWith("blob:")).slice();
    out.first = first.length;
    m.show();
    await wait(500);
    out.redrawFrees = first.length >= 2 && first.every((u) => freed.has(u));
    const before = made.length;
    const x = root.querySelector(".recent-x");
    x.click();
    await wait(300);
    out.removeFrees = made.slice(before - 2, before).filter((u) => freed.has(u)).length >= 1;
  } finally { URL.createObjectURL = mk; URL.revokeObjectURL = rv; root.remove(); }
  for (const u of made) rv.call(URL, u);
  for (const r of await recents.list(T)) if (r.name.startsWith("zz-colortest")) await recents.remove(r.id);
  return { pass: !!(out.redrawFrees && out.removeFrees), out };
}
