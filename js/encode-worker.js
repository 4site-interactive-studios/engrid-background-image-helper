let encodePromise = null;

function loadEncoder() {
  if (!encodePromise) {
    encodePromise = import("https://esm.sh/@jsquash/webp@1?bundle")
      .then((mod) => mod.encode)
      // Drop the memo on failure. A rejected promise kept here would be handed to every
      // later encode, so one bad network moment disabled encoding until a page reload.
      .catch((err) => {
        encodePromise = null;
        throw err;
      });
  }
  return encodePromise;
}

self.onmessage = async (e) => {
  const { id, imageData, quality, lossless } = e.data || {};
  try {
    const encode = await loadEncoder();
    // In lossless mode libwebp reads `quality` as an effort/speed dial rather than a
    // fidelity one, so it is pinned to 100 (slowest, smallest) and the lossy quality
    // value is ignored — the pixels come through untouched either way.
    const buffer = await encode(imageData, lossless
      ? { lossless: 1, quality: 100, exact: 1 }
      : { quality });
    const bytes = new Uint8Array(buffer);
    self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && (err.message || String(err)) });
  }
};
