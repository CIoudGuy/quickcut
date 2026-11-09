// Test harness for bgsavetest.js: the real background-remover worker, but Cache Storage refuses to
// save (like a private window or a full disk) and every model-part download is counted.
const realOpen = caches.open.bind(caches);
caches.open = async (name) => {
  const c = await realOpen(name);
  return new Proxy(c, { get: (t, k) => (k === "put" ? () => Promise.reject(new DOMException("quota", "QuotaExceededError")) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
};
self.__parts = 0;
const realFetch = fetch;
self.fetch = (u, o) => { if (/\/models\/.+\.\d{3}$/.test(String(u))) self.__parts++; return realFetch(u, o); };
// answer "how many parts were downloaded?" next to the worker's own protocol
addEventListener("message", (e) => { if (e.data?.op === "parts") postMessage({ parts: self.__parts }); });
await import(`../photo/bg.js?t=${Date.now()}`); // always the current code, never an HTTP-cached copy
postMessage({ ready: true }); // messages sent before this would find no handler
