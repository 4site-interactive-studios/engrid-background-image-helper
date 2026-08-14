export function triggerDownload(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType || "image/jpeg" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function suggestFilename(originalName, mimeType, suffix = "-bg") {
  const dot = originalName.lastIndexOf(".");
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = MIME_EXT[mimeType] || "jpg";
  return `${stem}${suffix}.${ext}`;
}
