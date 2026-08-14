const COLORS = {
  formFill: "rgba(31, 38, 47, 0.97)",
  formMaxStroke: "rgba(248, 81, 73, 0.95)",
  formMinStroke: "rgba(210, 153, 34, 0.95)",
  crop: "rgba(47, 129, 247, 0.95)",
  cropFill: "rgba(47, 129, 247, 0.08)",
  focal: "#ffffff",
  focalStroke: "#000000",
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const v = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const HANDLE_SIZE = 10;

export function fitCanvasToContainer(canvas, container) {
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
}

export function render({ canvas, image, settings, focal, crop, showSafeZone = true, fitMode = "cover", maxFitScale = 1 }) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const displayCrop = crop || { x: 0, y: 0, w: image.width, h: image.height };

  // Contain fit: show the whole crop, never scaled past 1:1 of its own pixels, centered.
  // The canvas stays transparent outside the drawn rect so the black .canvas-wrap shows through.
  if (fitMode === "contain") {
    const rect = containRect(canvas, displayCrop, maxFitScale);
    ctx.drawImage(
      image.bitmap,
      displayCrop.x, displayCrop.y, displayCrop.w, displayCrop.h,
      rect.x, rect.y, rect.w, rect.h
    );
    return;
  }

  const canvasAspect = canvas.width / canvas.height;
  const cropAspect = displayCrop.w / displayCrop.h;
  const fx = focal ? focal.x : 0.5;
  const fy = focal ? focal.y : 0.5;

  let srcX, srcY, srcW, srcH;
  if (canvasAspect > cropAspect) {
    srcW = displayCrop.w;
    srcH = displayCrop.w / canvasAspect;
    srcX = displayCrop.x;
    srcY = displayCrop.y + (displayCrop.h - srcH) * fy;
  } else {
    srcH = displayCrop.h;
    srcW = displayCrop.h * canvasAspect;
    srcX = displayCrop.x + (displayCrop.w - srcW) * fx;
    srcY = displayCrop.y;
  }

  ctx.drawImage(
    image.bitmap,
    srcX, srcY, srcW, srcH,
    0, 0, canvas.width, canvas.height
  );

  if (showSafeZone) {
    const focalX = focal ? focal.x : 0.5;
    const outputScale = srcW > 0 ? canvas.width / srcW : 1;
    const effectiveSafeZoneWidth = settings.safeZoneWidth * outputScale;
    const effectiveWarmBand = (settings.warmZoneBandWidthPx ?? WARM_ZONE_BAND_WIDTH) * outputScale;
    drawActiveSafeZone(
      ctx,
      canvas,
      effectiveSafeZoneWidth,
      focalX,
      settings.safeZoneColor || "#00FF00",
      effectiveWarmBand,
      settings.safeZoneFillAlpha,
      settings.safeZoneWarmColor
    );
    drawFocalSectionCircle(
      ctx,
      canvas,
      focal,
      settings.safeZoneColor || "#00FF00",
      settings.safeZoneFillAlpha != null ? settings.safeZoneFillAlpha : SAFE_ZONE_FILL_ALPHA,
      safeZonePosition(canvas.width, effectiveSafeZoneWidth, focalX),
      effectiveSafeZoneWidth
    );
  }
}

// Rule-of-thirds framing guides, drawn inside the crop box as single hairlines. The
// half-pixel offset keeps each one crisp rather than smeared across two device pixels.
export function drawRuleOfThirds(ctx, rect) {
  if (rect.w < 24 || rect.h < 24) return;

  ctx.save();
  ctx.beginPath();
  for (const t of [1 / 3, 2 / 3]) {
    const px = Math.round(rect.x + rect.w * t) + 0.5;
    ctx.moveTo(px, rect.y);
    ctx.lineTo(px, rect.y + rect.h);
    const py = Math.round(rect.y + rect.h * t) + 0.5;
    ctx.moveTo(rect.x, py);
    ctx.lineTo(rect.x + rect.w, py);
  }
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Where a crop lands on the canvas under contain fit. Exported so callers that map
// pointer/keyboard deltas back to source pixels use the same geometry as the draw.
export function containRect(canvas, crop, maxScale = 1) {
  const scale = Math.min(canvas.width / crop.w, canvas.height / crop.h, maxScale);
  const w = crop.w * scale;
  const h = crop.h * scale;
  return { x: (canvas.width - w) / 2, y: (canvas.height - h) / 2, w, h, scale };
}

export function safeZonePosition(canvasWidth, columnWidthPx, focalX) {
  const colW = Math.round(Math.min(columnWidthPx, canvasWidth));
  if (colW <= 0) return null;
  let x;
  if (focalX <= 0.25) x = 0;
  else if (focalX >= 0.75) x = canvasWidth - colW;
  else x = Math.round((canvasWidth - colW) / 2);
  return { x, w: colW };
}

export function drawFocalSectionCircle(ctx, canvas, focal, color, fillAlpha, safeZoneRect, radiusReferenceWidth) {
  if (!focal || !safeZoneRect) return;

  const sectionCenter = (coord, total) => {
    if (coord < 1 / 3) return total / 6;
    if (coord < 2 / 3) return total / 2;
    return (total * 5) / 6;
  };

  const cx = safeZoneRect.x + safeZoneRect.w / 2;
  const refW = radiusReferenceWidth != null ? radiusReferenceWidth : safeZoneRect.w;
  const radius = (refW * 3) / 8;
  if (radius <= 0) return;
  const cy = sectionCenter(focal.y, canvas.height);

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

const SAFE_ZONE_FILL_ALPHA = 0.3;
const WARM_ZONE_BAND_WIDTH = 30;
const WARM_ZONE_OPACITY_FACTORS = [1, 0.8, 0.6, 0.4, 0.2];

export function drawActiveSafeZone(ctx, canvas, columnWidthPx, focalX, color, warmZoneBandWidthPx = WARM_ZONE_BAND_WIDTH, safeZoneFillAlpha = SAFE_ZONE_FILL_ALPHA, warmZoneColor = color) {
  const colW = Math.round(Math.min(columnWidthPx, canvas.width));
  if (colW <= 0) return;

  let x;
  if (focalX <= 0.25) x = 0;
  else if (focalX >= 0.75) x = canvas.width - colW;
  else x = Math.round((canvas.width - colW) / 2);

  ctx.save();
  drawWarmZoneBands(ctx, canvas, x, colW, warmZoneColor || color, warmZoneBandWidthPx, safeZoneFillAlpha);

  ctx.fillStyle = rgba(color, safeZoneFillAlpha);
  ctx.fillRect(x, 0, colW, canvas.height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, canvas.height);
  ctx.moveTo(x + colW - 0.5, 0);
  ctx.lineTo(x + colW - 0.5, canvas.height);
  ctx.stroke();
  ctx.restore();
}

function drawWarmZoneBands(ctx, canvas, safeX, safeW, color, bandWidthPx, safeZoneFillAlpha) {
  const bandW = Math.max(0, Math.round(bandWidthPx));
  if (bandW <= 0) return;

  for (let i = 0; i < WARM_ZONE_OPACITY_FACTORS.length; i++) {
    const alpha = safeZoneFillAlpha * WARM_ZONE_OPACITY_FACTORS[i];
    const offset = i * bandW;

    const leftX = Math.max(0, safeX - offset - bandW);
    const leftW = safeX - offset - leftX;
    if (leftW > 0) {
      ctx.fillStyle = rgba(color, alpha);
      ctx.fillRect(leftX, 0, leftW, canvas.height);
    }

    const rightX = safeX + safeW + offset;
    const rightW = Math.min(bandW, canvas.width - rightX);
    if (rightW > 0) {
      ctx.fillStyle = rgba(color, alpha);
      ctx.fillRect(rightX, 0, rightW, canvas.height);
    }
  }
}

function formRectAt(widthPx, layout, canvasWidth, scale) {
  const w = Math.min(canvasWidth, Math.round(widthPx * scale));
  let x;
  if (layout === "left") x = 0;
  else if (layout === "right") x = canvasWidth - w;
  else x = Math.round((canvasWidth - w) / 2);
  return { x, w };
}

function drawFormRect(ctx, canvas, settings, scale) {
  const rect = formRectAt(settings.formWidth, settings.layout, canvas.width, scale);
  ctx.save();
  ctx.fillStyle = COLORS.formFill;
  ctx.fillRect(rect.x, 0, rect.w, canvas.height);
  ctx.strokeStyle = COLORS.formMaxStroke;
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x + 1, 1, rect.w - 2, canvas.height - 2);
  ctx.restore();
}

function drawCropFrame(ctx, crop, scale) {
  if (!crop) return;
  const x = crop.x * scale;
  const y = crop.y * scale;
  const w = crop.w * scale;
  const h = crop.h * scale;

  ctx.save();
  ctx.fillStyle = COLORS.cropFill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.crop;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  ctx.fillStyle = COLORS.crop;
  const handles = handlePositions(x, y, w, h);
  for (const h0 of handles) {
    ctx.fillRect(h0.cx - HANDLE_SIZE / 2, h0.cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  }
  ctx.restore();
}

function handlePositions(x, y, w, h) {
  return [
    { name: "nw", cx: x,         cy: y },
    { name: "n",  cx: x + w / 2, cy: y },
    { name: "ne", cx: x + w,     cy: y },
    { name: "e",  cx: x + w,     cy: y + h / 2 },
    { name: "se", cx: x + w,     cy: y + h },
    { name: "s",  cx: x + w / 2, cy: y + h },
    { name: "sw", cx: x,         cy: y + h },
    { name: "w",  cx: x,         cy: y + h / 2 },
  ];
}

export function hitTestCropHandle(crop, scale, px, py) {
  if (!crop) return null;
  const x = crop.x * scale;
  const y = crop.y * scale;
  const w = crop.w * scale;
  const h = crop.h * scale;
  const handles = handlePositions(x, y, w, h);
  for (const h0 of handles) {
    if (
      px >= h0.cx - HANDLE_SIZE &&
      px <= h0.cx + HANDLE_SIZE &&
      py >= h0.cy - HANDLE_SIZE &&
      py <= h0.cy + HANDLE_SIZE
    ) {
      return h0.name;
    }
  }
  if (px >= x && px <= x + w && py >= y && py <= y + h) return "move";
  return null;
}

function drawFocalMarker(ctx, focal, canvas) {
  if (!focal) return;
  const cx = focal.x * canvas.width;
  const cy = focal.y * canvas.height;

  ctx.save();
  ctx.strokeStyle = COLORS.focalStroke;
  ctx.lineWidth = 3;
  drawCross(ctx, cx, cy, 10);
  ctx.strokeStyle = COLORS.focal;
  ctx.lineWidth = 1.5;
  drawCross(ctx, cx, cy, 10);

  ctx.fillStyle = COLORS.focal;
  ctx.strokeStyle = COLORS.focalStroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawCross(ctx, cx, cy, size) {
  ctx.beginPath();
  ctx.moveTo(cx - size, cy);
  ctx.lineTo(cx + size, cy);
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx, cy + size);
  ctx.stroke();
}
