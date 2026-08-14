let worker = null;
let nextId = 0;
const pending = new Map();

function rejectAllPending(message) {
  for (const { reject } of pending.values()) {
    reject(new Error(message));
  }
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./encode-worker.js?v=3", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { id, ok, bytes, error } = e.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(bytes);
    else entry.reject(new Error(error || "encode failed"));
  };
  worker.onerror = (e) => {
    rejectAllPending(e.message || "encode worker error");
    if (worker) {
      worker.terminate();
      worker = null;
    }
  };
  worker.onmessageerror = () => {
    rejectAllPending("encode worker messageerror");
    if (worker) {
      worker.terminate();
      worker = null;
    }
  };
  return worker;
}

export function encodeWebpInWorker(imageData, quality, lossless = false) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try {
      const w = getWorker();
      w.postMessage({ id, imageData, quality, lossless });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}
