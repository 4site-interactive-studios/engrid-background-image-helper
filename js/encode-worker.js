let encodePromise = null;

function loadEncoder() {
  if (!encodePromise) {
    encodePromise = import("https://esm.sh/@jsquash/webp@1?bundle").then(
      (mod) => mod.encode
    );
  }
  return encodePromise;
}

self.onmessage = async (e) => {
  const { id, imageData, quality } = e.data || {};
  try {
    const encode = await loadEncoder();
    const buffer = await encode(imageData, { quality });
    const bytes = new Uint8Array(buffer);
    self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && (err.message || String(err)) });
  }
};
