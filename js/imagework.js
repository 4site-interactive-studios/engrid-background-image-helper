export async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function decodeBytes(bytes, mimeType, filename) {
  const blob = new Blob([bytes], { type: mimeType || "image/jpeg" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    return {
      bitmap: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes,
      mimeType: mimeType || blob.type,
      filename: filename || "image",
      byteLength: bytes.byteLength,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImageElement(src, opts = {}) {
  const img = new Image();
  if (opts.crossOrigin) img.crossOrigin = opts.crossOrigin;
  img.src = src;
  if (img.decode) {
    try {
      await img.decode();
      return img;
    } catch {}
  }
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to decode image"));
  });
  return img;
}

export async function loadFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await hashBytes(bytes);
  const decoded = await decodeBytes(bytes, file.type, file.name);
  return { ...decoded, hash };
}

// Public image proxy that mirrors any fetchable image with CORS headers added.
// Needed because common client hosts (e.g. Engaging Networks' rackcdn image
// library) serve images without Access-Control-Allow-Origin, so the browser
// blocks every direct read from this page.
const CORS_PROXY_PREFIX = "https://images.weserv.nl/?url=";

async function fetchImageBytes(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mimeType = res.headers.get("content-type") || "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, mimeType };
}

async function decodeFetchedBytes(bytes, mimeType, sourceUrl) {
  const hash = await hashBytes(bytes);
  const filename = sourceUrl.split("/").pop().split("?")[0] || "image";
  const decoded = await decodeBytes(bytes, mimeType, filename);
  return { ...decoded, hash };
}

export async function loadFromUrl(url) {
  let directErr = null;

  try {
    const { bytes, mimeType } = await fetchImageBytes(url);
    return await decodeFetchedBytes(bytes, mimeType, url);
  } catch (err) {
    directErr = err;
  }

  try {
    const img = await loadImageElement(url, { crossOrigin: "anonymous" });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise((res, rej) =>
      canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
        "image/jpeg",
        0.95
      )
    );
    const ab = await blob.arrayBuffer();
    const fallbackBytes = new Uint8Array(ab);
    const hash = await hashBytes(fallbackBytes);
    const filename = url.split("/").pop().split("?")[0] || "image";
    return {
      bitmap: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes: fallbackBytes,
      mimeType: blob.type,
      filename,
      byteLength: fallbackBytes.byteLength,
      hash,
    };
  } catch {}

  try {
    const { bytes, mimeType } = await fetchImageBytes(
      CORS_PROXY_PREFIX + encodeURIComponent(url)
    );
    return await decodeFetchedBytes(bytes, mimeType, url);
  } catch {}

  if (directErr && /^HTTP \d+$/.test(directErr.message || "")) {
    throw new Error(`Couldn't load this URL (${directErr.message}).`);
  }
  throw new Error(
    "Couldn't load this URL, even through a CORS proxy. Download the image locally and drop it here."
  );
}

export function computeCropFromFocalPoint(image, focal, outputW, outputH) {
  const sourceAspect = image.width / image.height;
  const targetAspect = outputW / outputH;

  let cropW, cropH;
  if (sourceAspect > targetAspect) {
    cropH = image.height;
    cropW = cropH * targetAspect;
  } else {
    cropW = image.width;
    cropH = cropW / targetAspect;
  }

  let cropX = focal.x * image.width - cropW / 2;
  let cropY = focal.y * image.height - cropH / 2;

  cropX = Math.max(0, Math.min(cropX, image.width - cropW));
  cropY = Math.max(0, Math.min(cropY, image.height - cropH));

  return {
    x: Math.round(cropX),
    y: Math.round(cropY),
    w: Math.round(cropW),
    h: Math.round(cropH),
  };
}

export function clampCrop(crop, image) {
  let { x, y, w, h } = crop;
  w = Math.max(20, Math.min(w, image.width));
  h = Math.max(20, Math.min(h, image.height));
  x = Math.max(0, Math.min(x, image.width - w));
  y = Math.max(0, Math.min(y, image.height - h));
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  };
}

let workCanvas = null;
let workCtx = null;

export function cropToImageData(image, crop, outputW, outputH) {
  if (!workCanvas) {
    workCanvas = document.createElement("canvas");
    workCtx = workCanvas.getContext("2d");
    workCtx.imageSmoothingQuality = "high";
  }
  if (workCanvas.width !== outputW) workCanvas.width = outputW;
  if (workCanvas.height !== outputH) workCanvas.height = outputH;
  workCtx.imageSmoothingQuality = "high";
  workCtx.clearRect(0, 0, outputW, outputH);
  workCtx.drawImage(image.bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, outputW, outputH);
  return workCtx.getImageData(0, 0, outputW, outputH);
}

export function formatBytes(n) {
  if (n == null) return "—";
  return `${Math.round(n / 1024).toLocaleString("en-US")} KB`;
}
