import { loadSettings, saveSettings, loadImageState, saveImageState } from "./storage.js?v=39";
import {
  loadFromFile,
  loadFromUrl,
  computeCropFromFocalPoint,
  clampCrop,
  cropToImageData,
  formatBytes,
} from "./imagework.js?v=33";
import { fitCanvasToContainer, render, drawActiveSafeZone, drawFocalSectionCircle, safeZonePosition, containRect, drawRuleOfThirds } from "./overlay.js?v=48";
import { triggerDownload, suggestFilename } from "./compress.js?v=33";
import { encodeWebpInWorker } from "./encode-client.js?v=3";

const $ = (id) => document.getElementById(id);
const MAX_RECOMMENDED_LONGEST_SIDE = 2000;
let DEBUG = new URLSearchParams(window.location.search).get("debug") === "true";

const PRESETS = [
  { id: "aiusa-left", name: "AIUSA - Left", layout: "left", formWidth: 550, safeZoneWidth: 350 },
  { id: "ngs-left", name: "NGS - Left", layout: "left", formWidth: 550, safeZoneWidth: 350 },
  { id: "nwf-left", name: "NWF - Left", layout: "left", formWidth: 800, safeZoneWidth: 200 },
  { id: "oceana-left", name: "Oceana - Left", layout: "left", formWidth: 680, safeZoneWidth: 350 },
  { id: "ran-left", name: "RAN - Left", layout: "left", formWidth: 680, safeZoneWidth: 300 },
  { id: "shatterproof-left", name: "Shatterproof - Left", layout: "left", formWidth: 640, safeZoneWidth: 350 },
  { id: "tpl-left", name: "TPL - Left", layout: "left", formWidth: 768, safeZoneWidth: 350 },
  { id: "wwf-center", name: "WWF - Center", layout: "center", formWidth: 1200, safeZoneWidth: 1200 },
];

// General mode is the plain crop/optimize workflow: no form to simulate, so no safe
// zone, no focal point, and the preview shows the whole crop instead of a cover fit.
const GENERAL_PANEL_WIDTH = 420;

const ASPECT_RATIOS = [
  { id: "16:9", w: 16, h: 9 },
  { id: "3:2", w: 3, h: 2 },
  { id: "4:3", w: 4, h: 3 },
  { id: "5:4", w: 5, h: 4 },
  { id: "1:1", w: 1, h: 1 },
  { id: "4:5", w: 4, h: 5 },
  { id: "3:4", w: 3, h: 4 },
  { id: "2:3", w: 2, h: 3 },
  { id: "9:16", w: 9, h: 16 },
  { id: "16:10", w: 16, h: 10 },
  { id: "21:9", w: 21, h: 9 },
  { id: "1.91:1", w: 1.91, h: 1 },
];

function isGeneralMode() {
  return state.settings.mode === "general";
}

// Retina: the export keeps its full pixel dimensions, but it is meant to be shown at
// half those dimensions on a 2x display, so the preview draws it at half scale.
function isRetina() {
  return isGeneralMode() && !!state.settings.retina;
}

function previewFitScale() {
  return isRetina() ? 0.5 : 1;
}

function isDimensionsSizeMode() {
  return state.settings.sizeMode === "dimensions";
}

// "Free" means the crop box isn't locked to any ratio. It's tracked separately from
// aspectRatio so that typing dimensions which happen not to match a common ratio can't
// silently switch it on — only the dropdown's Free entry and the Dimensions checkbox do,
// and being one flag it carries across a size-mode switch.
function isFreeCrop() {
  return !!state.settings.freeCrop;
}

function setFreeCrop(free) {
  if (state.settings.freeCrop === free) return;
  state.settings.freeCrop = free;
  persistSettings();
  applySizeModeUi();
  updateRatioHint();
  if (state.image) {
    syncCropUiFromState();
    rerender();
  }
}

// Point the dropdown at whatever ratio the current output matches. Never lands on "free":
// that is a deliberate choice, not something a set of dimensions can imply.
function syncAspectFromDims() {
  const match = aspectIdForDims(state.outputW, state.outputH);
  if (match !== "free") state.settings.aspectRatio = match;
  applySizeModeUi();
}

function aspectRatioById(id) {
  return ASPECT_RATIOS.find((r) => r.id === id) || null;
}

function selectedAspect() {
  return aspectRatioById(state.settings.aspectRatio);
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

function realRatioLabel(w, h) {
  const d = gcd(Math.round(w), Math.round(h)) || 1;
  const rw = Math.round(w) / d;
  const rh = Math.round(h) / d;
  if (rw > 50 || rh > 50) return `${(w / h).toFixed(2)}:1`;
  return `${rw}:${rh}`;
}

// Log-space distance so a ratio and its reciprocal are judged symmetrically —
// 2:1 is as far from 16:9 as 1:2 is from 9:16.
function nearestAspectId(w, h) {
  const target = Math.log(w / h);
  let best = ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of ASPECT_RATIOS) {
    const d = Math.abs(target - Math.log(r.w / r.h));
    if (d < bestDiff) { best = r; bestDiff = d; }
  }
  return best.id;
}

function aspectIdForDims(w, h) {
  const ratio = w / h;
  for (const r of ASPECT_RATIOS) {
    if (Math.abs(ratio - r.w / r.h) / (r.w / r.h) < 0.005) return r.id;
  }
  return "free";
}

const CLIENT_URL_PATTERNS = [
  {
    pattern: "https://c27fdabe952dfc357fe25ebf5c8897ee.ssl.cf5.rackcdn.com/1839/",
    presetIds: ["aiusa-left"],
  },
  {
    pattern: "https://acb0a5d73b67fccd4bbe-c2d8138f0ea10a18dd4c43ec3aa4240a.ssl.cf5.rackcdn.com/10033/",
    presetIds: ["nwf-left"],
  },
  {
    pattern: "https://bd6ca9cefa6fb6e0adf1-c2f9aa1adb9f60a775f60074e4c86031.ssl.cf5.rackcdn.com/20002/",
    presetIds: ["tpl-left"],
  },
];

function clientMatchForUrl(url) {
  if (!url) return null;
  for (const m of CLIENT_URL_PATTERNS) {
    if (url.includes(m.pattern)) return m;
  }
  return null;
}

function applyClientPresetFilter(allowedIds) {
  const allowed = new Set([...allowedIds, "custom"]);
  for (const opt of els.preset.options) {
    opt.hidden = !allowed.has(opt.value);
  }
}

function clearClientPresetFilter() {
  for (const opt of els.preset.options) {
    opt.hidden = false;
  }
}

function matchingPresetId() {
  const s = state.settings;
  for (const p of PRESETS) {
    if (p.layout === s.layout && p.formWidth === s.formWidth && p.safeZoneWidth === s.safeZoneWidth) {
      return p.id;
    }
  }
  return null;
}

function syncPresetUI() {
  if (state.settings.preset == null) {
    state.settings.preset = matchingPresetId() || "custom";
  }
  const id = state.settings.preset;
  els.preset.value = id;
  const p = PRESETS.find((p) => p.id === id);
  if (p) {
    els.formSafeZoneFieldset.classList.add("is-preset");
  } else {
    els.formSafeZoneFieldset.classList.remove("is-preset");
  }
}

const SAFE_ZONE_COLORS = ["#FF0000", "#FF7F00", "#FFFF00", "#00FF00", "#0000FF", "#4B0082"];
const SAFE_ZONE_COLOR_NAMES = {
  "#FF0000": "Red",
  "#FF7F00": "Orange",
  "#FFFF00": "Yellow",
  "#00FF00": "Green",
  "#0000FF": "Blue",
  "#4B0082": "Indigo",
};

function safeZoneColorTooltip() {
  if (state.settings.safeZoneAuto) return "Auto - Select for maximum contrast";
  const hex = (state.settings.safeZoneColor || "").toUpperCase();
  return SAFE_ZONE_COLOR_NAMES[hex] || "";
}
const DEFAULT_SAFE_ZONE_COLOR = "#00FF00";


function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substr(0, 2), 16),
    g: parseInt(h.substr(2, 2), 16),
    b: parseInt(h.substr(4, 2), 16),
  };
}

function rgbDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function computeAverageColor(focalXOverride) {
  if (!state.image) return null;

  const cropX = state.crop ? state.crop.x : 0;
  const cropY = state.crop ? state.crop.y : 0;
  const cropW = state.crop ? state.crop.w : state.image.width;
  const cropH = state.crop ? state.crop.h : state.image.height;

  const outputW = state.outputW || cropW;
  const sourcePerOutput = outputW > 0 ? cropW / outputW : 1;

  const settings = effectiveSafeZoneSettings();
  const safeZoneSource = settings.safeZoneWidth * sourcePerOutput;

  const focalX = focalXOverride != null ? focalXOverride : effectiveFocal().x;
  let safeXInCrop;
  if (focalX <= 0.25) safeXInCrop = 0;
  else if (focalX >= 0.75) safeXInCrop = cropW - safeZoneSource;
  else safeXInCrop = (cropW - safeZoneSource) / 2;

  const leftX = Math.max(0, safeXInCrop);
  const rightX = Math.min(cropW, safeXInCrop + safeZoneSource);
  const sampleW = Math.max(1, rightX - leftX);

  const sx = cropX + leftX;
  const sy = cropY;
  const sw = sampleW;
  const sh = cropH;

  const sampleSize = 8;
  const tmp = document.createElement("canvas");
  tmp.width = sampleSize;
  tmp.height = sampleSize;
  const ctx = tmp.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(state.image.bitmap, sx, sy, sw, sh, 0, 0, sampleSize, sampleSize);
    const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
    let r = 0, g = 0, b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    return { r: r / n, g: g / n, b: b / n };
  } catch {
    return null;
  }
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

function rgbToHex({ r, g, b }) {
  const toHex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function pickAutoColor(avg) {
  const avgLuma = 0.299 * avg.r + 0.587 * avg.g + 0.114 * avg.b;
  const candidates = SAFE_ZONE_COLORS.map((color) => {
    const rgb = hexToRgb(color);
    const luma = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
    return {
      color,
      name: SAFE_ZONE_COLOR_NAMES[color],
      distance: rgbDistance(avg, rgb),
      lumaDiff: Math.abs(avgLuma - luma),
    };
  });
  candidates.sort((a, b) => {
    if (Math.abs(a.distance - b.distance) > 0.5) return b.distance - a.distance;
    return b.lumaDiff - a.lumaDiff;
  });
  const picked = candidates[0];
  return {
    color: picked.color,
    debug: {
      pickedName: picked.name,
      candidates: candidates.map((c) => ({
        color: c.color,
        name: c.name,
        distance: Math.round(c.distance),
        lumaDiff: Math.round(c.lumaDiff),
      })),
    },
  };
}

function autoColorCacheSignature() {
  if (!state.image) return null;
  const c = state.crop
    ? `${state.crop.x},${state.crop.y},${state.crop.w},${state.crop.h}`
    : "none";
  const safeZoneWidth = effectiveSafeZoneSettings().safeZoneWidth;
  return `${state.image.hash || state.image.filename}|${c}|${state.outputW}|${safeZoneWidth}`;
}

function getAutoColorForFocalX(focalX) {
  const sig = autoColorCacheSignature();
  if (!sig) return null;
  if (!state.autoColorCache || state.autoColorCache.signature !== sig) {
    state.autoColorCache = { signature: sig, values: Object.create(null) };
  }
  const key = String(focalX);
  if (state.autoColorCache.values[key]) return state.autoColorCache.values[key];
  const avg = computeAverageColor(focalX);
  if (!avg) return null;
  const { color, debug } = pickAutoColor(avg);
  state.autoColorCache.values[key] = color;
  if (DEBUG) {
    const avgHex = rgbToHex({
      r: Math.round(avg.r),
      g: Math.round(avg.g),
      b: Math.round(avg.b),
    });
    console.log(
      `[auto-color] focal=${focalX} avg=${avgHex} → overlay=${color}`,
      debug
    );
  }
  return color;
}

function schedulePrecomputeOtherAutoColors(currentFocalX) {
  const others = [0, 0.5, 1].filter((x) => x !== currentFocalX);
  if (others.length === 0) return;
  const run = () => {
    if (!state.settings.safeZoneAuto || !state.image) return;
    for (const x of others) getAutoColorForFocalX(x);
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 500 });
  } else {
    setTimeout(run, 0);
  }
}

function updateAutoSafeZoneColor() {
  if (!state.settings.safeZoneAuto || !state.image || isGeneralMode()) return;
  const focalX = effectiveFocal().x;
  const newColor = getAutoColorForFocalX(focalX);
  if (!newColor) return;
  if (newColor !== state.settings.safeZoneColor) {
    state.settings.safeZoneColor = newColor;
    persistSettings();
    applySafeZoneColorVar();
    rerender();
    renderModal();
  }
  schedulePrecomputeOtherAutoColors(focalX);
}

const MANUAL_CYCLE_ORDER = [3, 4, 5, 0, 1, 2];

function cycleSafeZoneColor() {
  if (state.settings.safeZoneAuto) {
    state.settings.safeZoneAuto = false;
    state.settings.safeZoneColor = SAFE_ZONE_COLORS[MANUAL_CYCLE_ORDER[0]];
  } else {
    const current = (state.settings.safeZoneColor || "").toUpperCase();
    const i = SAFE_ZONE_COLORS.indexOf(current);
    const pos = MANUAL_CYCLE_ORDER.indexOf(i);
    if (pos === -1 || pos === MANUAL_CYCLE_ORDER.length - 1) {
      state.settings.safeZoneAuto = true;
      updateAutoSafeZoneColor();
    } else {
      state.settings.safeZoneColor = SAFE_ZONE_COLORS[MANUAL_CYCLE_ORDER[pos + 1]];
    }
  }
  persistSettings();
  applySafeZoneColorVar();
  rerender();
  renderModal();
}

function resetSafeZoneColor() {
  if (state.settings.safeZoneAuto) {
    updateAutoSafeZoneColor();
    return;
  }
  state.settings.safeZoneAuto = true;
  persistSettings();
  applySafeZoneColorVar();
  updateAutoSafeZoneColor();
  rerender();
  renderModal();
}

function applySafeZoneColorVar() {
  document.documentElement.style.setProperty(
    "--zone-color",
    state.settings.safeZoneColor || "#00ff00"
  );
  if (els.safeZoneColor) {
    els.safeZoneColor.classList.toggle("is-auto", !!state.settings.safeZoneAuto);
    els.safeZoneColor.dataset.tooltip = safeZoneColorTooltip();
  }
}

function applyPreset(id) {
  const p = PRESETS.find((p) => p.id === id);
  state.settings.preset = id;
  state.settings.presetUserSet = true;
  if (p) {
    state.settings.layout = p.layout;
    state.settings.formWidth = p.formWidth;
    state.settings.safeZoneWidth = p.safeZoneWidth;
  }
  resetSafeZoneColor();
  persistSettings();
  syncSettingsToInputs();
  applyLayoutFromSettings();
  syncPresetUI();
  updateAutoSafeZoneColor();
  rerender();
  if (modalState.active) renderModal();
}

function applyModeUi() {
  const general = isGeneralMode();
  els.layout.classList.toggle("mode-general", general);
  for (const toggle of els.modeToggles) {
    for (const btn of toggle.querySelectorAll(".mode-toggle-btn")) {
      const active = btn.dataset.mode === state.settings.mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    }
  }
  if (els.aspectRatio) els.aspectRatio.value = state.settings.aspectRatio || "16:9";
  if (els.retina) els.retina.checked = !!state.settings.retina;
  applySizeModeUi();
  applyLayoutFromSettings();
  updateFocalAttributeHint();
  updateRatioHint();
}

function applySizeModeUi() {
  const dimensions = isDimensionsSizeMode();
  els.layout.classList.toggle("size-mode-dimensions", dimensions);
  els.layout.classList.toggle("size-mode-aspect", !dimensions);
  // The dropdown's Free entry and the Dimensions checkbox are two views of one setting,
  // so both are re-synced together whenever either could have changed.
  if (els.aspectRatio) {
    els.aspectRatio.value = isFreeCrop() ? "free" : (state.settings.aspectRatio || "16:9");
  }
  if (els.cropLock) {
    const locked = !isFreeCrop();
    els.cropLock.setAttribute("aria-pressed", locked ? "true" : "false");
    els.cropLock.title = locked
      ? "Crop is locked to these dimensions"
      : "Crop is unlocked — drag any shape";
  }
  if (!els.sizeToggle) return;
  for (const btn of els.sizeToggle.querySelectorAll(".mode-toggle-btn")) {
    const active = btn.dataset.sizeMode === state.settings.sizeMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  }
}

function setSizeMode(mode) {
  if (mode !== "dimensions" && mode !== "aspect") return;
  if (state.settings.sizeMode === mode) return;
  state.settings.sizeMode = mode;
  // Dimensions that already sit exactly on a common ratio pre-select it, rather than
  // snapping the crop to whatever ratio happened to be chosen last. An explicit Free
  // choice is left alone — it outranks the ratio the numbers imply.
  if (mode === "aspect" && !isFreeCrop()) {
    const match = aspectIdForDims(state.outputW, state.outputH);
    if (match !== "free") state.settings.aspectRatio = match;
  }
  persistSettings();
  applySizeModeUi();
  // Switching to aspect hands the crop back to the selected ratio; switching to
  // dimensions keeps whatever size is already set, which is what the fields show.
  if (state.image && mode === "aspect" && !isFreeCrop()) {
    applyAspectRatio(state.settings.aspectRatio || "16:9");
  } else {
    updateRatioHint();
  }
}

function setMode(mode) {
  if (mode !== "general" && mode !== "background") return;
  if (state.settings.mode === mode) return;
  state.settings.mode = mode;
  persistSettings();
  applyModeUi();
  if (!state.image) {
    rerender();
    return;
  }
  // Each mode has its own idea of a default crop, so switching starts fresh rather
  // than carrying over a crop shaped by rules that no longer apply.
  state.hasManualCrop = false;
  if (isGeneralMode()) {
    applyAspectRatio(state.settings.aspectRatio || "16:9");
  } else {
    state.outputW = state.image.width;
    state.outputH = state.image.height;
    state.outputAspect = state.outputW / state.outputH;
    clampOutputToCap();
    recomputeCropFromFocal();
    syncOutputAndQualityToInputs();
    updateRemoveCropVisibility();
    updateAutoSafeZoneColor();
    rerender();
    if (modalState.active) renderModal();
    persistImageState();
    scheduleEstimate();
  }
}

function markPresetCustomIfChanged() {
  const matching = matchingPresetId();
  state.settings.preset = matching || "custom";
  state.settings.presetUserSet = true;
}

function applyCustomDefaultIfUnset() {
  if (!state.settings.presetUserSet) {
    applyPreset("custom");
  }
}

const state = {
  settings: loadSettings(),
  image: null,
  focal: { x: 0.5, y: 0.5 },
  crop: null,
  outputW: 1800,
  outputH: 1200,
  outputAspect: 1800 / 1200,
  quality: 55,
  scale: 1,
  estimatedBytes: null,
  compressedBitmap: null,
  compareMode: false,
  compareHoverOverlay: false,
  hasManualCrop: false,
  maxResolution: 2500,
  usingSource: false,
  encodedBytes: null,
  autoColorCache: null,
  imageUrl: null,
};

const els = {
  layout: document.querySelector(".layout"),
  modeToggles: Array.from(document.querySelectorAll(".mode-toggle")),
  sizeToggle: $("size-mode-toggle"),
  cropLock: $("crop-lock"),
  dimsNote: $("dims-note"),
  aspectRatio: $("aspect-ratio"),
  ratioHint: $("ratio-hint"),
  ratioReal: $("ratio-real"),
  ratioMatch: $("ratio-match"),
  ratioMatchId: $("ratio-match-id"),
  ratioNearestWrap: $("ratio-nearest-wrap"),
  ratioNearest: $("ratio-nearest"),
  retina: $("retina"),
  displaySize: $("display-size"),
  safeZoneSetting: document.querySelector(".safe-zone-setting"),
  focalPointSetting: document.querySelector(".focal-point-setting"),
  cropFocalSetting: document.querySelector(".crop-focal-setting"),
  formWidth: $("form-width"),
  formLayout: $("form-layout"),
  safeZoneWidth: $("safe-zone-width"),
  preset: $("preset"),
  presetDetails: $("preset-details"),
  formSafeZoneFieldset: document.querySelector(".form-safezone-fieldset"),
  safeZoneColor: $("safe-zone-color"),
  infoBtn: $("info-btn"),
  infoModal: $("info-modal"),
  canvasWrap: $("canvas-wrap"),
  uploadBtn: $("upload-btn"),
  testImageLink: $("test-image-link"),
  imageUrl: $("image-url"),
  fileInput: $("file-input"),
  clearImageRow: $("clear-image-row"),
  clearImage: $("clear-image"),
  metaDims: $("meta-dims"),
  metaSize: $("meta-size"),
  outputMetaLabel: $("output-meta-label"),
  outputMetaDims: $("output-meta-dims"),
  outputMetaSize: $("output-meta-size"),
  outputMetaCompare: $("output-meta-compare"),
  error: $("error"),
  canvas: $("preview-canvas"),
  previewSpinner: $("preview-spinner"),
  emptyState: $("empty-state"),
  sourceInfo: $("source-info"),
  focalGrid: $("focal-grid"),
  cropFocalPreset: $("crop-focal-preset"),
  focalAttributeHint: $("focal-attribute-hint"),
  outputWLabel: $("output-w-label"),
  outputHLabel: $("output-h-label"),
  outputW: $("output-w"),
  outputH: $("output-h"),
  resetCrop: $("reset-crop"),
  maxResolution: $("max-resolution"),
  qualityVal: $("quality-val"),
  maxResolutionVal: $("max-resolution-val"),
  compareBtn: $("compare-btn"),
  quality: $("quality"),
  compressionWarning: $("compression-warning"),
  download: $("download"),
  modal: $("crop-inline"),
  modalCanvas: $("modal-canvas"),
  cropSizeWarning: $("crop-size-warning"),
  cropSizeWarningText: $("crop-size-warning-text"),
  cropFixBtn: $("crop-fix-btn"),
  resetCropRow: $("reset-crop-row"),
};

const modalState = {
  active: false,
  scale: 1,
  crop: null,
  drag: null,
  removeCrop: false,
  focal: null,
};

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
}
function clearError() {
  els.error.textContent = "";
  els.error.hidden = true;
}

function setPreviewLoading(active) {
  els.previewSpinner.hidden = !active;
  els.previewSpinner.setAttribute("aria-hidden", active ? "false" : "true");
}

function persistSettings() {
  saveSettings(state.settings);
  syncUrlFromState();
  commitHistory();
}

// The URL carries the configuration, and the image too when it came from a link — a
// pasted or ?src= image is re-fetchable by anyone, so the whole view travels. Local files
// cannot, so those links open on the landing page and apply the settings to whatever the
// recipient loads. src is written from state rather than passed through, so replacing the
// image replaces the link instead of stranding the previous one.
const URL_PASSTHROUGH = ["debug"];

function urlParamsFromState() {
  const p = new URLSearchParams();
  const s = state.settings;
  p.set("mode", s.mode);
  if (isGeneralMode()) {
    p.set("size", s.sizeMode);
    if (isDimensionsSizeMode()) {
      if (state.image) {
        p.set("w", String(state.outputW));
        p.set("h", String(state.outputH));
      }
    } else {
      p.set("ratio", s.aspectRatio);
    }
    // Free is orthogonal to the size mode, so it rides along in either.
    if (isFreeCrop()) p.set("free", "1");
    p.set("retina", s.retina ? "1" : "0");
  } else {
    p.set("preset", s.preset);
    if (!PRESETS.some((preset) => preset.id === s.preset)) {
      p.set("layout", s.layout);
      p.set("formwidth", String(s.formWidth));
      p.set("safezone", String(s.safeZoneWidth));
    }
  }
  p.set("maxres", String(state.maxResolution));
  p.set("quality", String(state.quality));
  // The focal point places the safe zone, so a background-mode link needs it to show the
  // recipient the same thing. General mode always frames from the centre.
  if (!isGeneralMode() && state.focal) {
    p.set("focal", `${state.focal.x},${state.focal.y}`);
  }
  // Crop is in source-image pixels, so it lands identically on the same image. Omitted
  // when it is the whole frame, which is the default anyway.
  const c = state.crop;
  if (state.image && c) {
    const r = [c.x, c.y, c.w, c.h].map(Math.round);
    const isFull = r[0] === 0 && r[1] === 0 &&
      r[2] === state.image.width && r[3] === state.image.height;
    if (!isFull) p.set("crop", r.join(","));
  }
  if (state.imageUrl) p.set("src", state.imageUrl);
  return p;
}

// Must go through window.history: this module declares its own `history` const for
// undo/redo, which shadows the global one for the whole file. A bare history.replaceState
// here resolves to that object instead, and silently does nothing.
// Purely cosmetic besides, so a failure must never take the settings change down with it.
function syncUrlFromState() {
  let qs;
  let currentQs;
  try {
    const current = new URLSearchParams(window.location.search);
    currentQs = current.toString();
    const next = urlParamsFromState();
    for (const key of URL_PASSTHROUGH) {
      const value = current.get(key);
      if (value != null) next.set(key, value);
    }
    qs = next.toString();
  } catch (err) {
    if (DEBUG) console.warn("[url] could not build query", err);
    return;
  }
  if (DEBUG) console.log(`[url] ?${qs}`);
  if (qs === currentQs) return;
  if (typeof window.history?.replaceState !== "function") return;
  try {
    window.history.replaceState(null, "", `${window.location.pathname}?${qs}`);
  } catch (err) {
    if (DEBUG) console.warn("[url] replaceState unavailable", err);
  }
}

// Values that can only take effect once an image exists wait here; applyImage() otherwise
// resets max resolution and quality to their per-image defaults.
const urlDefaults = { w: null, h: null, maxResolution: null, quality: null, crop: null, focal: null };

function applyUrlParams(params) {
  const s = state.settings;
  const num = (key) => {
    const n = parseInt(params.get(key), 10);
    return Number.isFinite(n) ? n : null;
  };

  const mode = params.get("mode");
  if (mode === "general" || mode === "background") s.mode = mode;

  const size = params.get("size");
  if (size === "dimensions" || size === "aspect") s.sizeMode = size;

  const ratio = params.get("ratio");
  // ratio=free predates the separate flag and still arrives in older shared links.
  if (ratio === "free") s.freeCrop = true;
  else if (ratio && aspectRatioById(ratio)) s.aspectRatio = ratio;
  const free = params.get("free");
  if (free === "0" || free === "1") s.freeCrop = free === "1";

  const retina = params.get("retina");
  if (retina === "0" || retina === "1") s.retina = retina === "1";

  const preset = params.get("preset");
  if (preset) {
    const match = PRESETS.find((p) => p.id === preset);
    s.preset = match ? match.id : "custom";
    s.presetUserSet = true;
    if (match) {
      s.layout = match.layout;
      s.formWidth = match.formWidth;
      s.safeZoneWidth = match.safeZoneWidth;
    }
  }
  const layout = params.get("layout");
  if (layout === "left" || layout === "center" || layout === "right") s.layout = layout;
  const formWidth = num("formwidth");
  if (formWidth) s.formWidth = Math.max(100, Math.min(2000, formWidth));
  const safeZone = num("safezone");
  if (safeZone) s.safeZoneWidth = Math.max(50, Math.min(2000, safeZone));

  const maxres = num("maxres");
  if (maxres != null && MAX_RES_PRESETS.some((p) => p.value === maxres)) {
    urlDefaults.maxResolution = maxres;
    state.maxResolution = maxres;
  }
  const quality = num("quality");
  if (quality != null) {
    urlDefaults.quality = snapQualityToPreset(quality);
    state.quality = urlDefaults.quality;
  }

  const w = num("w");
  const h = num("h");
  if (w && h) {
    urlDefaults.w = Math.max(1, Math.min(99999, w));
    urlDefaults.h = Math.max(1, Math.min(99999, h));
  }

  const focal = (params.get("focal") || "").split(",").map(Number);
  if (focal.length === 2 && focal.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    urlDefaults.focal = { x: focal[0], y: focal[1] };
  }

  // Held until an image exists — the rect is meaningless without one to clamp it against.
  const crop = (params.get("crop") || "").split(",").map(Number);
  if (crop.length === 4 && crop.every((v) => Number.isFinite(v)) && crop[2] > 0 && crop[3] > 0) {
    urlDefaults.crop = { x: crop[0], y: crop[1], w: crop[2], h: crop[3] };
  }
}

function persistImageState() {
  if (!state.image) return;
  saveImageState(state.image.hash, {
    filename: state.image.filename,
    focalPoint: state.focal,
    cropFrame: state.crop,
    outputW: state.outputW,
    outputH: state.outputH,
    quality: state.quality,
    hasManualCrop: state.hasManualCrop,
  });
  syncUrlFromState();
  commitHistory();
}

const HISTORY_MAX = 50;
const HISTORY_MERGE_MS = 400;
const history = {
  undo: [],
  redo: [],
  baseline: null,
  baselineTime: 0,
  applying: false,
};

function snapshotForHistory() {
  if (!state.image) return null;
  return {
    imageHash: state.image.hash,
    focal: { ...state.focal },
    crop: state.crop ? { ...state.crop } : null,
    outputW: state.outputW,
    outputH: state.outputH,
    outputAspect: state.outputAspect,
    quality: state.quality,
    maxResolution: state.maxResolution,
    hasManualCrop: state.hasManualCrop,
    settings: { ...state.settings },
  };
}

function snapshotsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.imageHash !== b.imageHash) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function commitHistory() {
  if (history.applying) return;
  const snap = snapshotForHistory();
  if (!snap) return;
  if (!history.baseline) {
    history.baseline = snap;
    history.baselineTime = Date.now();
    return;
  }
  if (snapshotsEqual(snap, history.baseline)) return;
  const now = Date.now();
  if (now - history.baselineTime < HISTORY_MERGE_MS && history.undo.length > 0) {
    history.baseline = snap;
    history.baselineTime = now;
    return;
  }
  history.undo.push(history.baseline);
  if (history.undo.length > HISTORY_MAX) history.undo.shift();
  history.redo.length = 0;
  history.baseline = snap;
  history.baselineTime = now;
}

function resetHistory() {
  history.undo.length = 0;
  history.redo.length = 0;
  history.baseline = snapshotForHistory();
  history.baselineTime = Date.now();
}

function applyHistorySnapshot(snap) {
  if (!snap || !state.image || snap.imageHash !== state.image.hash) return;
  history.applying = true;
  state.focal = { ...snap.focal };
  state.crop = snap.crop ? { ...snap.crop } : null;
  state.outputW = snap.outputW;
  state.outputH = snap.outputH;
  state.outputAspect = snap.outputAspect;
  state.quality = snap.quality;
  state.maxResolution = snap.maxResolution;
  state.hasManualCrop = snap.hasManualCrop;
  state.settings = { ...snap.settings };
  modalState.crop = state.crop ? { ...state.crop } : null;
  modalState.focal = { ...state.focal };
  syncSettingsToInputs();
  applyModeUi();
  applyLayoutFromSettings();
  applySafeZoneColorVar();
  syncPresetUI();
  syncOutputAndQualityToInputs();
  updateRemoveCropVisibility();
  highlightFocalPreset();
  updateFocalAttributeHint();
  updateRatioHint();
  updateAutoSafeZoneColor();
  rerender();
  if (modalState.active) renderModal();
  saveSettings(state.settings);
  saveImageState(state.image.hash, {
    filename: state.image.filename,
    focalPoint: state.focal,
    cropFrame: state.crop,
    outputW: state.outputW,
    outputH: state.outputH,
    quality: state.quality,
    hasManualCrop: state.hasManualCrop,
  });
  scheduleEstimate();
  history.baseline = snapshotForHistory();
  history.baselineTime = Date.now();
  history.applying = false;
}

function undoHistory() {
  if (history.undo.length === 0) return;
  const current = snapshotForHistory();
  const prev = history.undo.pop();
  if (current) history.redo.push(current);
  applyHistorySnapshot(prev);
}

function redoHistory() {
  if (history.redo.length === 0) return;
  const current = snapshotForHistory();
  const next = history.redo.pop();
  if (current) history.undo.push(current);
  applyHistorySnapshot(next);
}

function syncSettingsToInputs() {
  els.formWidth.value = state.settings.formWidth;
  els.formLayout.value = state.settings.layout;
  els.safeZoneWidth.value = state.settings.safeZoneWidth;
  updateCenterModeControls();
}

function applyLayoutFromSettings() {
  // General mode has no form, so the panel is a fixed width and always sits left;
  // the same --form-width variable still drives the panel/preview split.
  const general = isGeneralMode();
  const panelWidth = general ? GENERAL_PANEL_WIDTH : state.settings.formWidth;
  document.documentElement.style.setProperty("--form-width", `${panelWidth}px`);
  els.layout.classList.remove("form-pos-left", "form-pos-center", "form-pos-right");
  els.layout.classList.add(`form-pos-${general ? "left" : state.settings.layout}`);
  updateCenterModeControls();
  highlightFocalPreset();
}

function isCenterFormPosition() {
  return state.settings.layout === "center";
}

function updateCenterModeControls() {
  const hide = isCenterFormPosition() || isGeneralMode();
  els.safeZoneSetting.hidden = hide;
  els.focalPointSetting.hidden = hide;
  if (els.cropFocalSetting) els.cropFocalSetting.hidden = hide;
  updateFocalAttributeHint();
}

function updateFocalAttributeHint() {
  if (!state.image || isGeneralMode()) {
    els.focalAttributeHint.hidden = true;
    return;
  }
  const posMap = {
    "0,0": "left top",
    "0,0.5": "left center",
    "0,1": "left bottom",
    "0.5,0": "center top",
    "0.5,1": "center bottom",
    "1,0": "right top",
    "1,0.5": "right center",
    "1,1": "right bottom",
  };
  const value = `${state.focal.x},${state.focal.y}`;
  const position = posMap[value];
  if (position) {
    const attr = `data-background-position="${position}"`;
    els.focalAttributeHint.dataset.attr = attr;
    els.focalAttributeHint.innerHTML = `ENgrid attribute: <code>${attr}</code>`;
    els.focalAttributeHint.hidden = false;
  } else {
    els.focalAttributeHint.hidden = true;
  }
}

function effectiveFocal() {
  return isCenterFormPosition() || isGeneralMode() ? { x: 0.5, y: 0.5 } : state.focal;
}

function effectiveSafeZoneSettings() {
  if (!isCenterFormPosition()) return state.settings;
  return {
    ...state.settings,
    safeZoneWidth: state.settings.formWidth,
    safeZoneColor: "#FF0000",
    safeZoneWarmColor: state.settings.safeZoneColor || "#00FF00",
  };
}

function effectiveCropSafeZoneSettings() {
  if (!isCenterFormPosition()) return effectiveSafeZoneSettings();
  return {
    ...state.settings,
    safeZoneWidth: state.settings.formWidth,
    safeZoneColor: "#000000",
    safeZoneWarmColor: state.settings.safeZoneColor || "#00FF00",
  };
}

function syncOutputAndQualityToInputs() {
  updateOutputDimensionLabels();
  updateOutputMeta();
  els.outputW.value = state.outputW;
  els.outputH.value = state.outputH;
  els.quality.value = state.quality;
  updateQualityDisplay();
  updateMaxResolutionDisplay();
  updateCompressionWarning();
}

const QUALITY_PRESETS = [
  { value: 40, label: "Smaller file" },
  { value: 55, label: "Balanced" },
  { value: 70, label: "Higher quality" },
  { value: 100, label: "Maximum quality" },
];

const MAX_RES_PRESETS = [
  { value: 1500, label: "1,500px" },
  { value: 2500, label: "2,500px" },
  { value: 5000, label: "5,000px" },
  { value: 0, label: "No limit" },
];

function nearestPresetIndex(presets, value) {
  let bestIdx = 0;
  let bestDiff = Math.abs(presets[0].value - value);
  for (let i = 1; i < presets.length; i++) {
    const d = Math.abs(presets[i].value - value);
    if (d < bestDiff) { bestIdx = i; bestDiff = d; }
  }
  return bestIdx;
}

function snapQualityToPreset(q) {
  return QUALITY_PRESETS[nearestPresetIndex(QUALITY_PRESETS, q)].value;
}

// Maximum quality with no resolution cap is a request for an untouched copy, so the
// encoder switches to lossless rather than merely a very high lossy setting.
function isLossless() {
  return state.maxResolution === 0 && state.quality === 100;
}

function updateQualityDisplay() {
  const idx = nearestPresetIndex(QUALITY_PRESETS, state.quality);
  els.quality.value = String(idx);
  if (els.qualityVal) {
    els.qualityVal.textContent = isLossless() ? "Lossless" : QUALITY_PRESETS[idx].label;
  }
}

function updateMaxResolutionDisplay() {
  const idx = state.maxResolution === 0
    ? MAX_RES_PRESETS.findIndex(p => p.value === 0)
    : nearestPresetIndex(MAX_RES_PRESETS.filter(p => p.value > 0), state.maxResolution);
  els.maxResolution.value = String(idx);
  if (els.maxResolutionVal) els.maxResolutionVal.textContent = MAX_RES_PRESETS[idx].label;
  // Lossless depends on both sliders, so the quality label follows this one too.
  updateQualityDisplay();
}

function syncCompareUi() {
  els.compareBtn.classList.toggle("active", state.compareMode);
  els.compareBtn.textContent = state.compareMode ? "Original" : "Compare";

  const hide = state.compareMode || state.compareHoverOverlay;
  els.infoBtn.hidden = hide || !state.image;
}

function updateCompressionWarning() {
  els.compressionWarning.hidden = true;
  els.compressionWarning.textContent = "";
}

function updateOutputDimensionLabels() {
  if (!state.image) {
    els.outputWLabel.textContent = "Width (px)";
    els.outputHLabel.textContent = "Height (px)";
    return;
  }

  const intrinsicW = state.hasManualCrop && state.crop
    ? Math.round(state.crop.w)
    : state.image.width;
  const intrinsicH = state.hasManualCrop && state.crop
    ? Math.round(state.crop.h)
    : state.image.height;
  const isResized = state.outputW !== intrinsicW || state.outputH !== intrinsicH;

  els.outputWLabel.textContent = isResized
    ? "Resized Width"
    : state.hasManualCrop ? "Cropped Width" : "Intrinsic Width";
  els.outputHLabel.textContent = isResized
    ? "Resized Height"
    : state.hasManualCrop ? "Cropped Height" : "Intrinsic Height";
}

function updateOutputMeta() {
  if (!state.image) {
    els.outputMetaLabel.textContent = "Output:";
    els.outputMetaDims.textContent = "";
    els.outputMetaSize.textContent = "";
    els.outputMetaCompare.textContent = "";
    els.outputMetaSize.classList.remove("is-estimating", "is-error");
    return;
  }

  els.outputMetaLabel.textContent = "Output:";
  els.outputMetaDims.textContent = `${state.outputW.toLocaleString("en-US")} × ${state.outputH.toLocaleString("en-US")}`;
  els.download.disabled = state.estimatedBytes == null;
  els.download.classList.toggle("is-estimating", state.estimatedBytes == null);
  if (state.estimatedBytes != null) {
    els.outputMetaSize.textContent = formatBytes(state.estimatedBytes);
    els.outputMetaSize.classList.remove("is-estimating", "is-error");
    if (state.usingSource) {
      els.outputMetaCompare.textContent = " (using original)";
    } else if (state.image.byteLength > 0) {
      const pct = ((state.estimatedBytes - state.image.byteLength) / state.image.byteLength) * 100;
      const rounded = Math.abs(pct).toFixed(0);
      if (rounded === "0") {
        els.outputMetaCompare.textContent = "";
      } else {
        const word = pct >= 0 ? "larger" : "smaller";
        els.outputMetaCompare.textContent = ` (${rounded}% ${word})`;
      }
    } else {
      els.outputMetaCompare.textContent = "";
    }
  } else {
    if (!els.outputMetaSize.textContent || els.outputMetaSize.classList.contains("is-error")) {
      els.outputMetaSize.textContent = "…";
      els.outputMetaSize.classList.remove("is-error");
    }
    els.outputMetaSize.classList.add("is-estimating");
  }
  updateDownloadLabel();
}

// Percent the encode differs from the source file; null until an estimate exists.
function outputSizeDeltaPct() {
  if (!state.image || state.estimatedBytes == null) return null;
  if (!state.image.byteLength) return null;
  return ((state.estimatedBytes - state.image.byteLength) / state.image.byteLength) * 100;
}

function updateDownloadLabel() {
  if (!els.download) return;
  if (state.usingSource) {
    els.download.textContent = "Download original";
    return;
  }
  const base = isLossless() ? "Download lossless WebP" : "Download optimized WebP";
  // Says which way the size went before the click. A rounded 0% is not worth saying —
  // "0% smaller" reads as noise where no change is the plain reading.
  const pct = outputSizeDeltaPct();
  const rounded = pct == null ? 0 : Math.round(pct);
  if (rounded === 0) {
    els.download.textContent = base;
    return;
  }
  els.download.textContent = `${base} (${Math.abs(rounded)}% ${rounded > 0 ? "larger" : "smaller"})`;
}

function outputIntrinsicDimensions() {
  if (!state.image) return null;
  return {
    w: state.hasManualCrop && state.crop ? Math.round(state.crop.w) : state.image.width,
    h: state.hasManualCrop && state.crop ? Math.round(state.crop.h) : state.image.height,
  };
}

function detailCap() {
  return state.maxResolution > 0 ? state.maxResolution : Infinity;
}

function rerender() {
  if (!state.image) {
    els.emptyState.hidden = false;
    const ctx = els.canvas.getContext("2d");
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    return;
  }
  els.emptyState.hidden = true;
  fitCanvasToContainer(els.canvas, els.canvas.parentElement);

  const useCompressed = state.compressedBitmap && !state.compareMode;
  const renderImage = useCompressed
    ? { bitmap: state.compressedBitmap, width: state.outputW, height: state.outputH }
    : state.image;
  const renderCrop = useCompressed
    ? { x: 0, y: 0, w: state.outputW, h: state.outputH }
    : state.crop;

  if (isGeneralMode()) {
    render({
      canvas: els.canvas,
      image: renderImage,
      settings: state.settings,
      focal: { x: 0.5, y: 0.5 },
      crop: renderCrop,
      showSafeZone: false,
      fitMode: "contain",
      maxFitScale: previewFitScale(),
    });
    return;
  }

  const baseSettings = effectiveSafeZoneSettings();
  let renderSettings = baseSettings;
  if (!useCompressed && state.crop && state.outputW > 0 && state.crop.w !== state.outputW) {
    const scale = state.crop.w / state.outputW;
    renderSettings = {
      ...baseSettings,
      safeZoneWidth: baseSettings.safeZoneWidth * scale,
      warmZoneBandWidthPx: (baseSettings.warmZoneBandWidthPx ?? 30) * scale,
    };
  }

  render({
    canvas: els.canvas,
    image: renderImage,
    settings: renderSettings,
    focal: effectiveFocal(),
    crop: renderCrop,
    showSafeZone: !state.compareMode && !state.compareHoverOverlay,
  });
}


function recomputeCropFromFocal() {
  if (!state.image) return;
  state.crop = computeCropFromFocalPoint(state.image, effectiveFocal(), state.outputW, state.outputH);
  updateRemoveCropVisibility();
  syncCropUiFromState();
  updateAutoSafeZoneColor();
}

function fullImageCrop() {
  return { x: 0, y: 0, w: state.image.width, h: state.image.height };
}

// A typed target is authoritative in general mode, so this only ever shrinks: down to the
// pixels the crop actually has (never upscale) and down to the max-resolution cap.
// clampOutputToCap() is deliberately not reused — it also grows the output back up to the
// cap, which would overwrite whatever size the user asked for.
// Dimensions mode treats the two axes as independent targets, so an over-large width must
// not drag the height down with it. Capping each axis against the source separately keeps
// the other one as typed. This still cannot upscale: for W <= imageW and H <= imageH, the
// largest W/H-shaped rect inside the image is always at least W x H.
function clampDimsToSource() {
  if (!state.image) return;
  const cap = detailCap();
  state.outputW = Math.max(1, Math.min(state.outputW, state.image.width, cap));
  state.outputH = Math.max(1, Math.min(state.outputH, state.image.height, cap));
  state.outputAspect = state.outputW / state.outputH;
}

function clampOutputToGeneral() {
  if (!state.image) return;
  const cropW = state.crop ? state.crop.w : state.image.width;
  const cropH = state.crop ? state.crop.h : state.image.height;
  const cap = detailCap();
  const scale = Math.min(
    1,
    cropW / state.outputW,
    cropH / state.outputH,
    cap / Math.max(state.outputW, state.outputH)
  );
  if (scale < 1) {
    state.outputW = Math.max(1, Math.round(state.outputW * scale));
    state.outputH = Math.max(1, Math.round(state.outputH * scale));
    state.outputAspect = state.outputW / state.outputH;
  }
}

// Largest rect of the given aspect that fits the image, centered on the current crop
// so retyping a dimension nudges the framing instead of jumping back to the middle.
function refitCropToAspect(aspect) {
  if (!state.image || !state.crop) return;
  const cx = state.crop.x + state.crop.w / 2;
  const cy = state.crop.y + state.crop.h / 2;
  let w = state.image.width;
  let h = w / aspect;
  if (h > state.image.height) {
    h = state.image.height;
    w = h * aspect;
  }
  state.crop = clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, state.image);
}

function applyAspectRatio(id) {
  state.settings.aspectRatio = id;
  // Choosing a concrete ratio is the opposite of choosing Free.
  state.settings.freeCrop = false;
  persistSettings();
  applySizeModeUi();
  if (!state.image) {
    updateRatioHint();
    return;
  }
  const r = aspectRatioById(id);
  if (r) {
    const aspect = r.w / r.h;
    state.outputH = Math.max(1, Math.round(state.outputW / aspect));
    state.outputAspect = state.outputW / state.outputH;
    state.hasManualCrop = false;
    state.crop = computeCropFromFocalPoint(state.image, { x: 0.5, y: 0.5 }, state.outputW, state.outputH);
  }
  clampOutputToGeneral();
  syncOutputAndQualityToInputs();
  updateRatioHint();
  updateRemoveCropVisibility();
  rerender();
  syncCropUiFromState();
  persistImageState();
  scheduleEstimate();
}

function updateRatioHint() {
  updateRetinaHint();
  if (!els.ratioHint) return;
  if (!isGeneralMode() || !state.image) {
    els.ratioHint.hidden = true;
    return;
  }
  els.ratioHint.hidden = false;
  els.ratioReal.textContent = realRatioLabel(state.outputW, state.outputH);
  const nearest = nearestAspectId(state.outputW, state.outputH);
  const exact = aspectIdForDims(state.outputW, state.outputH);
  // When the dimensions already sit on a common ratio there is nothing to snap to,
  // so name the match instead of offering a no-op link.
  if (exact !== "free") {
    els.ratioMatchId.textContent = exact;
    els.ratioMatch.hidden = false;
    els.ratioNearestWrap.hidden = true;
  } else {
    els.ratioMatch.hidden = true;
    els.ratioNearest.textContent = nearest;
    els.ratioNearest.dataset.ratio = nearest;
    els.ratioNearestWrap.hidden = false;
  }
}

// The display size doubles as the Retina row's value, matching how the Max Resolution
// and Quality rows show their current setting next to the label.
let dimNoteTimer = null;

// Explain a rejected size rather than just overwriting it. The two reasons are distinct:
// the source has no more pixels to give, or the max-resolution cap is lower still.
function reportDimClamp(askedW, askedH) {
  if (!els.dimsNote) return;
  const clampedW = state.outputW < askedW;
  const clampedH = state.outputH < askedH;
  if (!clampedW && !clampedH) {
    clearTimeout(dimNoteTimer);
    els.dimsNote.hidden = true;
    return;
  }

  for (const [input, hit] of [[els.outputW, clampedW], [els.outputH, clampedH]]) {
    if (!input || !hit) continue;
    input.classList.remove("is-clamped");
    void input.offsetWidth; // restart the flash if it's already mid-animation
    input.classList.add("is-clamped");
  }

  const cap = detailCap();
  const axis = clampedW && clampedH ? "Width and height" : clampedW ? "Width" : "Height";
  const to = clampedW && clampedH
    ? `${state.outputW.toLocaleString("en-US")} × ${state.outputH.toLocaleString("en-US")}`
    : (clampedW ? state.outputW : state.outputH).toLocaleString("en-US") + " px";
  const hitCap = cap !== Infinity && Math.max(state.outputW, state.outputH) >= cap - 1;
  els.dimsNote.textContent = hitCap
    ? `${axis} capped at ${to} by the ${cap.toLocaleString("en-US")}px max resolution.`
    : `${axis} capped at ${to} — the source has no more pixels to give.`;
  els.dimsNote.hidden = false;
  clearTimeout(dimNoteTimer);
  dimNoteTimer = setTimeout(() => { els.dimsNote.hidden = true; }, 6000);
}

// Sits with Source and Output as a third reading of the same file: the size it occupies
// on screen. Switched off there is no such size to report, hence n/a rather than a blank.
function updateRetinaHint() {
  if (!els.displaySize) return;
  if (!state.image) {
    els.displaySize.textContent = "";
    return;
  }
  if (!isRetina()) {
    els.displaySize.textContent = "n/a";
    return;
  }
  const w = Math.round(state.outputW / 2).toLocaleString("en-US");
  const h = Math.round(state.outputH / 2).toLocaleString("en-US");
  els.displaySize.textContent = `${w} × ${h} (retina)`;
}

function clampOutputToCap() {
  if (!state.image) return false;
  const intrinsic = outputIntrinsicDimensions();
  if (!intrinsic) return false;
  const cap = detailCap();
  const intrinsicMax = Math.max(intrinsic.w, intrinsic.h);
  const targetMax = Math.min(cap, intrinsicMax);
  const currentMax = Math.max(state.outputW, state.outputH);
  if (Math.abs(currentMax - targetMax) < 1) return false;
  if (targetMax >= intrinsicMax) {
    state.outputW = intrinsic.w;
    state.outputH = intrinsic.h;
  } else {
    const scale = targetMax / currentMax;
    state.outputW = Math.max(1, Math.round(state.outputW * scale));
    state.outputH = Math.max(1, Math.round(state.outputH * scale));
  }
  state.outputAspect = state.outputW / state.outputH;
  return true;
}

function updateRemoveCropVisibility() {
  let show = false;
  // General mode reaches a crop through the ratio and dimension controls as well as by
  // dragging, so offer the reset whenever the frame is smaller than the source — gating
  // on hasManualCrop hid it exactly when a typed size had just cropped the image.
  const framed = isGeneralMode() ? true : state.hasManualCrop;
  if (framed && state.crop && state.image) {
    const eps = 1;
    const fullCrop =
      Math.abs(state.crop.x) < eps &&
      Math.abs(state.crop.y) < eps &&
      Math.abs(state.crop.w - state.image.width) < eps &&
      Math.abs(state.crop.h - state.image.height) < eps;
    show = !fullCrop;
  }
  els.resetCropRow.classList.toggle("is-visible", show);
}

function snapFocalToPreset(focal) {
  const snap = (v) => (v < 0.25 ? 0 : v > 0.75 ? 1 : 0.5);
  return { x: snap(focal.x), y: snap(focal.y) };
}

function highlightFocalPreset() {
  const fx = String(state.focal.x);
  const fy = String(state.focal.y);
  if (els.focalGrid) {
    for (const cell of els.focalGrid.querySelectorAll(".focal-cell")) {
      const active = cell.dataset.fx === fx && cell.dataset.fy === fy;
      cell.classList.toggle("is-active", active);
      cell.setAttribute("aria-checked", active ? "true" : "false");
    }
  }
  if (els.cropFocalPreset) els.cropFocalPreset.value = `${state.focal.x},${state.focal.y}`;
}

function setFocalFromPreset(value) {
  const [x, y] = value.split(",").map(parseFloat);
  state.focal = { x, y };
  if (modalState.active) modalState.focal = { x, y };
  highlightFocalPreset();
}

async function applyImage(image) {
  state.image = image;
  try {
    const warmup = document.createElement("canvas");
    warmup.width = 8;
    warmup.height = 8;
    warmup.getContext("2d").drawImage(image.bitmap, 0, 0, 8, 8);
  } catch {}
  resetSafeZoneColor();
  els.sourceInfo.hidden = false;
  els.metaDims.textContent = `${image.width.toLocaleString("en-US")} × ${image.height.toLocaleString("en-US")}`;
  els.metaSize.textContent = formatBytes(image.byteLength);

  state.maxResolution = urlDefaults.maxResolution ?? 2500;
  state.usingSource = false;
  const saved = loadImageState(image.hash);
  if (saved) {
    state.focal = snapFocalToPreset(saved.focalPoint || { x: 0.5, y: 0.5 });
    state.outputW = saved.outputW || image.width;
    state.outputH = saved.outputH || image.height;
    state.quality = snapQualityToPreset(saved.quality ?? 55);
    state.hasManualCrop = !!saved.hasManualCrop;
    state.crop = saved.hasManualCrop && saved.cropFrame
      ? clampCrop(saved.cropFrame, image)
      : computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  } else {
    state.hasManualCrop = false;
    state.focal = { x: 0.5, y: 0.5 };
    if (Math.max(image.width, image.height) > state.maxResolution) {
      const ratio = state.maxResolution / Math.max(image.width, image.height);
      state.outputW = Math.round(image.width * ratio);
      state.outputH = Math.round(image.height * ratio);
    } else {
      state.outputW = image.width;
      state.outputH = image.height;
    }
    state.quality = urlDefaults.quality ?? 55;
    state.crop = computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  }

  // Set before the crop is derived below, since the focal point is what positions it.
  if (!saved && urlDefaults.focal) {
    state.focal = snapFocalToPreset(urlDefaults.focal);
  }
  state.outputAspect = state.outputW / state.outputH;
  updateMaxResolutionDisplay();
  clampOutputToCap();
  if (!state.hasManualCrop) {
    state.crop = computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  }
  // A first look at an image picks the mode that describes it: one already on a common
  // ratio opens on that ratio, anything else opens on its own dimensions, locked. Images
  // with saved state keep whatever was chosen for them last time.
  if (isGeneralMode() && !saved) {
    const match = aspectIdForDims(image.width, image.height);
    state.settings.freeCrop = false;
    if (match !== "free") {
      state.settings.sizeMode = "aspect";
      state.settings.aspectRatio = match;
    } else {
      state.settings.sizeMode = "dimensions";
    }
    persistSettings();
    applySizeModeUi();
  }
  if (isGeneralMode()) {
    if (state.hasManualCrop) {
      // A restored crop defines the ratio; reflect it in the dropdown rather than
      // overwriting the user's saved framing with the last-used preset.
      if (!isDimensionsSizeMode() && !isFreeCrop()) {
        syncAspectFromDims();
        persistSettings();
      }
      clampOutputToGeneral();
    } else if (isDimensionsSizeMode()) {
      // A target size carried in the URL applies to the first image that arrives; after
      // that the current target carries forward, since a fixed size is the point.
      if (!saved && urlDefaults.w && urlDefaults.h) {
        state.outputW = urlDefaults.w;
        state.outputH = urlDefaults.h;
      }
      state.outputAspect = state.outputW / state.outputH;
      refitCropToAspect(state.outputAspect);
      clampOutputToGeneral();
    } else {
      const r = selectedAspect();
      if (r) {
        state.outputH = Math.max(1, Math.round(state.outputW / (r.w / r.h)));
        state.outputAspect = state.outputW / state.outputH;
        state.crop = computeCropFromFocalPoint(image, { x: 0.5, y: 0.5 }, state.outputW, state.outputH);
      }
      clampOutputToGeneral();
    }
  }
  // An explicit crop from the link is the whole point of that link, so it lands last and
  // overrides whatever framing the mode would otherwise have derived. Output follows the
  // crop unless the link also named a size.
  if (!saved && urlDefaults.crop) {
    state.crop = clampCrop(urlDefaults.crop, image);
    state.hasManualCrop = true;
    if (!(isGeneralMode() && isDimensionsSizeMode() && urlDefaults.w && urlDefaults.h)) {
      state.outputW = Math.round(state.crop.w);
      state.outputH = Math.round(state.crop.h);
      state.outputAspect = state.outputW / state.outputH;
    }
    if (isGeneralMode()) clampOutputToGeneral();
    else clampOutputToCap();
  }
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  updateFocalAttributeHint();
  updateRatioHint();
  els.download.disabled = false;
  els.clearImageRow.hidden = false;
  els.infoBtn.hidden = false;
  els.compareBtn.hidden = false;
  els.layout.classList.add("has-image");
  updateRemoveCropVisibility();
  updateAutoSafeZoneColor();
  state.estimatedBytes = null;
  rerender();
  scheduleEstimate();
  activateCropUi();
  resetHistory();
  // Last word on the URL: earlier syncs during this load ran before the crop and target
  // size had settled, so they described a frame that no longer exists.
  syncUrlFromState();
}

function handleClearImage() {
  state.image = null;
  state.imageUrl = null;
  state.focal = { x: 0.5, y: 0.5 };
  state.crop = null;
  state.outputW = 1800;
  state.outputH = 1200;
  state.outputAspect = 1800 / 1200;
  state.quality = 55;
  state.estimatedBytes = null;
  els.sourceInfo.hidden = true;
  els.metaDims.textContent = "";
  els.metaSize.textContent = "";
  els.download.disabled = true;
  deactivateCropUi();
  els.clearImageRow.hidden = true;
  els.infoBtn.hidden = true;
  els.compareBtn.hidden = true;
  state.hasManualCrop = false;
  state.maxResolution = 2500;
  state.usingSource = false;
  updateMaxResolutionDisplay();
  if (state.compressedBitmap?.close) state.compressedBitmap.close();
  state.compressedBitmap = null;
  state.compareMode = false;
  state.compareHoverOverlay = false;
  updateRemoveCropVisibility();
  updateFocalAttributeHint();
  syncCompareUi();
  els.layout.classList.remove("has-image");
  if (els.imageUrl) els.imageUrl.value = "";
  clearTimeout(urlInputTimer);
  lastTriedUrl = null;
  clearError();
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  updateRatioHint();
  rerender();
  resetHistory();
}

async function handleFile(file) {
  clearError();
  if (!isGeneralMode()) {
    clearClientPresetFilter();
    applyCustomDefaultIfUnset();
  }
  const gen = ++loadGeneration;
  try {
    const image = await loadFromFile(file);
    if (gen !== loadGeneration) return;
    // Local bytes can't be linked to, so the previous src must not linger in the URL.
    state.imageUrl = null;
    lastTriedUrl = null;
    await applyImage(image);
  } catch (err) {
    if (gen !== loadGeneration) return;
    showError(err.message || String(err));
  }
}

// Remote images (e.g. the random photo) download over the network, so switch to the
// interface and show the spinner up front — the user sees their pick took effect
// immediately instead of staring at the landing page until the bytes arrive.
function showLoadingInterface() {
  els.emptyState.hidden = true;
  els.layout.classList.add("has-image");
  setPreviewLoading(true);
}

function restoreLandingAfterFailedLoad() {
  setPreviewLoading(false);
  if (!state.image) {
    els.layout.classList.remove("has-image");
    els.emptyState.hidden = false;
  }
}

async function handleUrl(url) {
  clearError();
  if (!url) return;
  const gen = ++loadGeneration;
  showLoadingInterface();
  try {
    const image = await loadFromUrl(url);
    if (gen !== loadGeneration) return;
    await applyImage(image);
  } catch (err) {
    if (gen !== loadGeneration) return;
    restoreLandingAfterFailedLoad();
    showError(err.message || String(err));
  }
}

function wireSettingsInputs() {
  els.preset.addEventListener("change", () => {
    applyPreset(els.preset.value);
  });
  els.formWidth.addEventListener("input", () => {
    state.settings.formWidth = clampInt(els.formWidth.value, 100, 2000, 550);
    markPresetCustomIfChanged();
    persistSettings();
    applyLayoutFromSettings();
    syncPresetUI();
    updateAutoSafeZoneColor();
    rerender();
    if (modalState.active) renderModal();
  });
  els.formLayout.addEventListener("change", () => {
    state.settings.layout = els.formLayout.value;
    markPresetCustomIfChanged();
    persistSettings();
    applyLayoutFromSettings();
    syncPresetUI();
    if (state.image && !state.hasManualCrop) recomputeCropFromFocal();
    updateAutoSafeZoneColor();
    rerender();
    if (modalState.active) renderModal();
  });
  els.safeZoneWidth.addEventListener("input", () => {
    state.settings.safeZoneWidth = clampInt(els.safeZoneWidth.value, 50, 2000, 350);
    markPresetCustomIfChanged();
    persistSettings();
    syncPresetUI();
    updateAutoSafeZoneColor();
    rerender();
    if (modalState.active) renderModal();
  });
  els.safeZoneColor.addEventListener("click", cycleSafeZoneColor);
  els.safeZoneColor.addEventListener("mouseenter", () => {
    els.safeZoneColor.classList.add("show-tooltip");
  });
  els.safeZoneColor.addEventListener("mouseleave", () => {
    els.safeZoneColor.classList.remove("show-tooltip");
  });
}

function wireInfoModal() {
  els.infoBtn.addEventListener("click", () => {
    els.infoModal.hidden = false;
    els.infoModal.setAttribute("aria-hidden", "false");
  });
  els.infoModal.addEventListener("click", (e) => {
    if (e.target.dataset.closeInfo !== undefined) {
      els.infoModal.hidden = true;
      els.infoModal.setAttribute("aria-hidden", "true");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      !e.defaultPrevented &&
      !els.infoModal.hidden
    ) {
      e.preventDefault();
      els.infoModal.hidden = true;
      els.infoModal.setAttribute("aria-hidden", "true");
    }
  });
}

function openTestImageModal() {
  const modal = document.getElementById("test-image-modal");
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function wireTestImageModal() {
  const modal = document.getElementById("test-image-modal");
  if (!modal) return;
  const close = () => {
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  };
  modal.addEventListener("click", async (e) => {
    if (e.target.dataset.closeTestImage !== undefined) {
      close();
      return;
    }
    const optionBtn = e.target.closest("[data-test-kind]");
    if (optionBtn && modal.contains(optionBtn)) {
      const kind = optionBtn.dataset.testKind;
      close();
      try {
        if (kind === "unsplash") {
          attemptUrlLoad(randomUnsplashUrl());
        } else {
          const file = await generateTestImage(kind);
          handleFile(file);
        }
      } catch (err) {
        showError(err.message || String(err));
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && !modal.hidden) {
      e.preventDefault();
      close();
    }
  });
}

function wireVideoModal() {
  const thumb = document.getElementById("video-thumb");
  const modal = document.getElementById("video-modal");
  const video = document.getElementById("overview-video");
  if (!thumb || !modal || !video) return;

  const open = () => {
    if (!video.src) video.src = "assets/overview.mp4";
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    video.play().catch(() => {});
  };
  const close = () => {
    video.pause();
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  };

  thumb.addEventListener("click", open);
  modal.addEventListener("click", (e) => {
    if (e.target.dataset.closeVideo !== undefined) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && !modal.hidden) {
      e.preventDefault();
      close();
    }
  });
}

let urlInputTimer = null;
let lastTriedUrl = null;
let loadGeneration = 0;
function attemptUrlLoad(url) {
  if (!url || url === lastTriedUrl) return;
  lastTriedUrl = url;
  // Recorded up front rather than on success, so the address bar keeps the link the user
  // actually asked for even while it is still loading.
  state.imageUrl = url;
  // Client presets configure the simulated form, which general mode doesn't have.
  if (isGeneralMode()) {
    handleUrl(url);
    return;
  }
  const match = clientMatchForUrl(url);
  if (match) {
    applyClientPresetFilter(match.presetIds);
    applyPreset(match.presetIds[0]);
  } else {
    clearClientPresetFilter();
    applyCustomDefaultIfUnset();
  }
  handleUrl(url);
}

const TEST_IMAGE_W = 4000;
const TEST_IMAGE_H = 3000;
const RAINBOW_COLORS = ["#ff5577", "#ffaa55", "#ffee55", "#88ff77", "#55aaff", "#aa77ff"];
const TEST_IMAGE_SOLID_FILLS = {
  black: "#000000",
  white: "#ffffff",
  grey: "#808080",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
};

// Genuine Unsplash photos served from the CORS-enabled images.unsplash.com CDN, which
// is Imgix-backed so we can resize to a large landscape on the fly. Unsplash retired the
// keyless source.unsplash.com random endpoint, so we pick at random from a curated set of
// stable photo IDs instead. The cache-buster also defeats attemptUrlLoad()'s duplicate-URL
// guard so repeat clicks keep loading fresh photos.
const UNSPLASH_PHOTO_IDS = [
  "photo-1506905925346-21bda4d32df4",
  "photo-1469474968028-56623f02e42e",
  "photo-1470071459604-3b5ec3a7fe05",
  "photo-1447752875215-b2761acb3c5d",
  "photo-1441974231531-c6227db76b6e",
  "photo-1501785888041-af3ef285b470",
  "photo-1505765050516-f72dcac9c60e",
  "photo-1426604966848-d7adac402bff",
  "photo-1472214103451-9374bd1c798e",
  "photo-1518495973542-4542c06a5843",
  "photo-1500534623283-312aade485b7",
  "photo-1490604001847-b712b0c2f967",
];

function randomUnsplashUrl() {
  const id = UNSPLASH_PHOTO_IDS[Math.floor(Math.random() * UNSPLASH_PHOTO_IDS.length)];
  return `https://images.unsplash.com/${id}?w=${TEST_IMAGE_W}&h=${TEST_IMAGE_H}&fit=crop&q=80&fm=jpg&_=${Date.now()}`;
}

function paintStripes(ctx, axis, colors) {
  if (axis === "horizontal") {
    const h = TEST_IMAGE_H / colors.length;
    for (let i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.fillRect(0, i * h, TEST_IMAGE_W, h);
    }
  } else {
    const w = TEST_IMAGE_W / colors.length;
    for (let i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.fillRect(i * w, 0, w, TEST_IMAGE_H);
    }
  }
}

async function generateTestImage(kind) {
  const c = document.createElement("canvas");
  c.width = TEST_IMAGE_W;
  c.height = TEST_IMAGE_H;
  const ctx = c.getContext("2d");
  const solid = TEST_IMAGE_SOLID_FILLS[kind];
  if (solid) {
    ctx.fillStyle = solid;
    ctx.fillRect(0, 0, TEST_IMAGE_W, TEST_IMAGE_H);
  } else if (kind === "bw-horizontal" || kind === "bw-vertical") {
    const bw = ["#000000", "#ffffff", "#000000", "#ffffff", "#000000", "#ffffff"];
    paintStripes(ctx, kind === "bw-horizontal" ? "horizontal" : "vertical", bw);
  } else if (kind === "rainbow-horizontal" || kind === "rainbow-vertical") {
    paintStripes(ctx, kind === "rainbow-horizontal" ? "horizontal" : "vertical", RAINBOW_COLORS);
  } else {
    throw new Error(`Unknown test image kind: ${kind}`);
  }
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
  return new File([blob], `test-${kind}.jpg`, { type: "image/jpeg" });
}

function wireImageInput() {
  els.uploadBtn.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      DEBUG = true;
      openTestImageModal();
      return;
    }
    els.fileInput.click();
  });

  els.testImageLink?.addEventListener("click", openTestImageModal);

  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (file) handleFile(file);
    els.fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    els.canvasWrap.addEventListener(ev, (e) => {
      e.preventDefault();
      els.canvasWrap.classList.add("drag");
    })
  );
  ["dragleave", "dragend", "drop"].forEach((ev) =>
    els.canvasWrap.addEventListener(ev, (e) => {
      e.preventDefault();
      els.canvasWrap.classList.remove("drag");
    })
  );
  els.canvasWrap.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  els.clearImage.addEventListener("click", handleClearImage);

  // The URL field is the deliberate path for client asset URLs: attemptUrlLoad() matches
  // the prefix against CLIENT_URL_PATTERNS, so pre-selecting the client preset happens
  // before the image lands. Debounced so a typed/pasted URL loads without pressing Enter.
  els.imageUrl?.addEventListener("input", () => {
    clearTimeout(urlInputTimer);
    const v = els.imageUrl.value.trim();
    if (/^https?:\/\/\S+\.\S+/i.test(v)) {
      urlInputTimer = setTimeout(() => attemptUrlLoad(v), 600);
    }
  });
  els.imageUrl?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(urlInputTimer);
    attemptUrlLoad(els.imageUrl.value.trim());
  });

  document.addEventListener("paste", (e) => {
    const target = e.target;
    const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleFile(file);
          return;
        }
      }
    }

    if (inField) return;
    const text = e.clipboardData?.getData("text")?.trim();
    if (text && /^https?:\/\//i.test(text)) {
      e.preventDefault();
      clearTimeout(urlInputTimer);
      attemptUrlLoad(text);
    }
  });
}

function wireFocalAndCrop() {
  els.focalAttributeHint.addEventListener("click", async () => {
    const attr = els.focalAttributeHint.dataset.attr;
    if (!attr) return;
    try {
      await navigator.clipboard.writeText(attr);
      const prev = els.focalAttributeHint.dataset.tooltip || "";
      els.focalAttributeHint.dataset.tooltip = "Copied!";
      els.focalAttributeHint.classList.add("copied");
      setTimeout(() => {
        els.focalAttributeHint.dataset.tooltip = prev;
        els.focalAttributeHint.classList.remove("copied");
      }, 1200);
    } catch (e) {}
  });

  els.focalGrid.addEventListener("click", (e) => {
    const cell = e.target.closest(".focal-cell");
    if (!cell || !state.image) return;
    const cropChanges = !state.hasManualCrop;
    setFocalFromPreset(`${cell.dataset.fx},${cell.dataset.fy}`);
    if (cropChanges) recomputeCropFromFocal();
    updateAutoSafeZoneColor();
    rerender();
    if (modalState.active) renderModal();
    persistImageState();
    if (cropChanges) scheduleEstimate();
    updateFocalAttributeHint();
  });

  if (els.cropFocalPreset) {
    els.cropFocalPreset.addEventListener("change", () => {
      if (!state.image || !modalState.active) return;
      const [x, y] = els.cropFocalPreset.value.split(",").map(parseFloat);
      modalState.focal = { x, y };
      renderModal();
    });
  }

  // Locked links the pair: typing one axis drives the other so the ratio survives the
  // edit. Unlocked leaves them independent and the crop reshapes to whatever they imply.
  const applyGeneralDimEdit = (axis) => {
    if (!isGeneralMode()) return;
    if (isFreeCrop()) {
      if (axis === "w") state.outputW = clampInt(els.outputW.value, 1, 99999, state.outputW);
      else state.outputH = clampInt(els.outputH.value, 1, 99999, state.outputH);
      state.outputAspect = state.outputW / state.outputH;
    } else {
      // Read the ratio before the edit and hold it, rather than recomputing from the pair
      // afterwards — recomputing would let rounding walk the ratio a little each keystroke.
      const aspect = state.outputAspect > 0 ? state.outputAspect : 1;
      if (axis === "w") {
        state.outputW = clampInt(els.outputW.value, 1, 99999, state.outputW);
        state.outputH = Math.max(1, Math.round(state.outputW / aspect));
        els.outputH.value = state.outputH;
      } else {
        state.outputH = clampInt(els.outputH.value, 1, 99999, state.outputH);
        state.outputW = Math.max(1, Math.round(state.outputH * aspect));
        els.outputW.value = state.outputW;
      }
      syncAspectFromDims();
    }
    persistSettings();
    if (state.image) {
      refitCropToAspect(state.outputAspect);
      state.hasManualCrop = false;
    }
    updateOutputDimensionLabels();
    updateOutputMeta();
    updateRatioHint();
    updateRemoveCropVisibility();
    rerender();
    syncCropUiFromState();
    persistImageState();
    scheduleEstimate();
  };

  // Just long enough that the linked axis waits for a pause instead of recomputing from
  // "1" then "12" then "128" as the digits land.
  const DIM_EDIT_DEBOUNCE = 250;
  let dimEditTimer = null;
  let dimEditAxis = null;
  const flushDimEdit = () => {
    if (!dimEditTimer) return;
    clearTimeout(dimEditTimer);
    dimEditTimer = null;
    const axis = dimEditAxis;
    dimEditAxis = null;
    applyGeneralDimEdit(axis);
  };

  const handleOutputDimInput = (axis) => {
    if (isGeneralMode()) {
      clearTimeout(dimEditTimer);
      dimEditAxis = axis;
      dimEditTimer = setTimeout(() => {
        dimEditTimer = null;
        dimEditAxis = null;
        applyGeneralDimEdit(axis);
      }, DIM_EDIT_DEBOUNCE);
      return;
    }
    if (axis === "w") {
      state.outputW = clampInt(els.outputW.value, 100, 6000, state.outputW);
      state.outputH = Math.max(1, Math.round(state.outputW / state.outputAspect));
      els.outputH.value = state.outputH;
    } else {
      state.outputH = clampInt(els.outputH.value, 100, 6000, state.outputH);
      state.outputW = Math.max(1, Math.round(state.outputH * state.outputAspect));
      els.outputW.value = state.outputW;
    }
    updateOutputDimensionLabels();
    if (state.image) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
  };

  els.outputW.addEventListener("input", () => handleOutputDimInput("w"));
  els.outputH.addEventListener("input", () => handleOutputDimInput("h"));
  // The no-upscale clamp runs on commit rather than per keystroke: clamping live would
  // shrink one axis while the user is still typing the other, and the shrunken value
  // would then become the baseline for the next edit.
  const commitOutputDims = () => {
    // Blur can beat the debounce, so settle any pending edit before clamping it.
    flushDimEdit();
    if (isGeneralMode() && state.image) {
      const askedW = state.outputW;
      const askedH = state.outputH;
      clampDimsToSource();
      if (state.outputW !== askedW || state.outputH !== askedH) {
        refitCropToAspect(state.outputAspect);
      }
      clampOutputToGeneral();
      // Silently rewriting the field reads as the app eating the input, so say what
      // happened and flash whichever field was actually reduced.
      reportDimClamp(askedW, askedH);
      updateRatioHint();
      persistImageState();
      scheduleEstimate();
    }
    els.outputW.value = state.outputW;
    els.outputH.value = state.outputH;
  };
  els.outputW.addEventListener("change", commitOutputDims);
  els.outputH.addEventListener("change", commitOutputDims);

  els.aspectRatio?.addEventListener("change", () => {
    if (!isGeneralMode()) return;
    if (els.aspectRatio.value === "free") setFreeCrop(true);
    else applyAspectRatio(els.aspectRatio.value);
  });

  els.ratioNearest?.addEventListener("click", () => {
    const id = els.ratioNearest.dataset.ratio;
    if (id) applyAspectRatio(id);
  });

  els.retina?.addEventListener("change", () => {
    state.settings.retina = els.retina.checked;
    persistSettings();
    updateRatioHint();
    rerender();
  });

  for (const toggle of els.modeToggles) {
    toggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".mode-toggle-btn");
      if (btn) setMode(btn.dataset.mode);
    });
  }

  els.sizeToggle?.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-toggle-btn");
    if (btn) setSizeMode(btn.dataset.sizeMode);
  });

  els.cropLock?.addEventListener("click", () => {
    setFreeCrop(els.cropLock.getAttribute("aria-pressed") === "true");
  });

  els.maxResolution.addEventListener("input", () => {
    const idx = clampInt(els.maxResolution.value, 0, MAX_RES_PRESETS.length - 1, 0);
    const wasLossless = isLossless();
    state.maxResolution = MAX_RES_PRESETS[idx].value;
    updateMaxResolutionDisplay();
    if (!state.image) return;
    // Reaching (or leaving) "No limit" at maximum quality flips the encoder between
    // lossless and lossy, which needs a re-encode even when the dimensions don't move.
    const losslessChanged = isLossless() !== wasLossless;
    let changed;
    if (isGeneralMode()) {
      const beforeW = state.outputW;
      const beforeH = state.outputH;
      clampOutputToGeneral();
      changed = state.outputW !== beforeW || state.outputH !== beforeH;
      if (changed) updateRatioHint();
    } else {
      changed = clampOutputToCap();
    }
    if (changed) syncOutputAndQualityToInputs();
    debouncedSliderEffects(() => {
      if (changed && !state.hasManualCrop) recomputeCropFromFocal();
      rerender();
      if (modalState.active) renderModal();
      updateAutoSafeZoneColor();
      if (changed || losslessChanged) {
        persistImageState();
        scheduleEstimate();
      }
    });
  });

  els.resetCrop.addEventListener("click", () => {
    if (!state.image) return;
    state.hasManualCrop = false;
    state.crop = fullImageCrop();
    state.outputW = state.crop.w;
    state.outputH = state.crop.h;
    state.outputAspect = state.outputW / state.outputH;
    clampOutputToCap();
    if (isGeneralMode()) {
      // Removing the crop hands the framing back to the source image, so the ratio
      // controls follow the image rather than the ratio that was just discarded.
      syncAspectFromDims();
      persistSettings();
      updateRatioHint();
    }
    syncOutputAndQualityToInputs();
    updateRemoveCropVisibility();
    rerender();
    syncCropUiFromState();
    persistImageState();
    scheduleEstimate();
  });

  els.canvas.addEventListener("keydown", (e) => {
    if (!state.image) return;
    const delta = arrowKeyDelta(e);
    if (!delta) return;
    e.preventDefault();
    nudgeCropByPreviewPx(delta.dx, delta.dy);
  });
}

function applyDrag(drag, dx, dy, aspect) {
  const { handle, startCrop } = drag;
  let { x, y, w, h } = startCrop;

  if (handle === "move") {
    return { x: x + dx, y: y + dy, w, h };
  }

  const right = x + w;
  const bottom = y + h;

  if (handle.includes("e")) w += dx;
  if (handle.includes("w")) { x += dx; w -= dx; }
  if (handle.includes("s")) h += dy;
  if (handle.includes("n")) { y += dy; h -= dy; }

  if (w / h > aspect) {
    const newW = h * aspect;
    if (handle.includes("w")) x = right - newW;
    w = newW;
  } else {
    const newH = w / aspect;
    if (handle.includes("n")) y = bottom - newH;
    h = newH;
  }

  return { x, y, w, h };
}

function downloadSuffix() {
  return isGeneralMode() ? "-optimized" : "-bg";
}

function wireCompression() {
  els.quality.addEventListener("input", () => {
    const idx = clampInt(els.quality.value, 0, QUALITY_PRESETS.length - 1, 1);
    state.quality = QUALITY_PRESETS[idx].value;
    updateQualityDisplay();
    updateCompressionWarning();
    debouncedSliderEffects(() => {
      scheduleEstimate();
      persistImageState();
    });
  });

  const setCompareHoverOverlay = (active) => {
    if (state.compareHoverOverlay === active) return;
    state.compareHoverOverlay = active;
    syncCompareUi();
    rerender();
  };
  const startCompareHover = () => {
    if (!state.compressedBitmap) return;
    setCompareHoverOverlay(true);
  };
  const endCompareHover = () => {
    setCompareHoverOverlay(false);
  };
  const startComparePress = (e) => {
    if (!state.compressedBitmap) return;
    e.preventDefault();
    if (state.compareMode) return;
    state.compareMode = true;
    syncCompareUi();
    rerender();
  };
  const endComparePress = () => {
    if (!state.compareMode) return;
    state.compareMode = false;
    syncCompareUi();
    rerender();
  };
  els.compareBtn.addEventListener("pointerenter", startCompareHover);
  els.compareBtn.addEventListener("pointerleave", () => {
    endCompareHover();
    endComparePress();
  });
  els.compareBtn.addEventListener("pointerdown", startComparePress);
  els.compareBtn.addEventListener("pointerup", endComparePress);
  els.compareBtn.addEventListener("pointercancel", endComparePress);

  els.download.addEventListener("click", async () => {
    if (!state.image || !state.crop) return;
    if (state.usingSource) {
      triggerDownload(
        state.image.bytes,
        suggestFilename(state.image.filename, state.image.mimeType, downloadSuffix()),
        state.image.mimeType
      );
      return;
    }
    if (state.encodedBytes) {
      triggerDownload(
        state.encodedBytes,
        suggestFilename(state.image.filename, "image/webp", downloadSuffix()),
        "image/webp"
      );
      return;
    }
    els.download.disabled = true;
    const oldText = els.download.textContent;
    els.download.textContent = "Encoding…";
    try {
      const imageData = cropToImageData(state.image, state.crop, state.outputW, state.outputH);
      const bytes = await encodeWebpInWorker(imageData, state.quality, isLossless());
      state.encodedBytes = bytes;
      state.estimatedBytes = bytes.byteLength;
      triggerDownload(bytes, suggestFilename(state.image.filename, "image/webp", downloadSuffix()), "image/webp");
      updateSizeEstimate();
    } catch (err) {
      showError(`Encoding failed: ${err.message || err}`);
    } finally {
      els.download.disabled = false;
      els.download.textContent = oldText;
      updateDownloadLabel();
    }
  });
}

let estimateTimer = null;
let estimateInFlight = false;
let estimateGeneration = 0;

let sliderEffectsTimer = null;
function debouncedSliderEffects(fn) {
  clearTimeout(sliderEffectsTimer);
  sliderEffectsTimer = setTimeout(fn, 200);
}
let scheduleRerenderRaf = 0;
function scheduleEstimate() {
  if (!state.image || !state.crop) {
    setPreviewLoading(false);
    return;
  }
  estimateGeneration++;
  state.estimatedBytes = null;
  state.encodedBytes = null;
  updateOutputMeta();
  setPreviewLoading(true);
  if (state.compressedBitmap?.close) state.compressedBitmap.close();
  state.compressedBitmap = null;
  state.compareMode = false;
  state.compareHoverOverlay = false;
  syncCompareUi();
  if (!scheduleRerenderRaf) {
    scheduleRerenderRaf = requestAnimationFrame(() => {
      scheduleRerenderRaf = 0;
      rerender();
    });
  }
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(runEstimate, 250);
}

async function runEstimate() {
  if (!state.image || !state.crop) {
    setPreviewLoading(false);
    return;
  }
  if (estimateInFlight) return;
  estimateInFlight = true;
  const gen = estimateGeneration;
  try {
    const imageData = cropToImageData(state.image, state.crop, state.outputW, state.outputH);
    const bytes = await encodeWebpInWorker(imageData, state.quality, isLossless());
    if (gen !== estimateGeneration) return;
    const isFullSize = !state.hasManualCrop &&
      state.outputW >= state.image.width &&
      state.outputH >= state.image.height;
    // Handing back the original instead of a larger re-encode is right for lossy output,
    // but lossless is expected to exceed a JPEG source and was asked for explicitly —
    // substituting the original there would silently ignore the request.
    state.usingSource = !isLossless() && isFullSize && bytes.byteLength > state.image.byteLength;
    if (state.usingSource) {
      state.estimatedBytes = state.image.byteLength;
      if (state.compressedBitmap?.close) state.compressedBitmap.close();
      state.compressedBitmap = null;
      rerender();
      updateSizeEstimate();
    } else {
      state.estimatedBytes = bytes.byteLength;
      state.encodedBytes = bytes;
      const blob = new Blob([bytes], { type: "image/webp" });
      const bitmap = await createImageBitmap(blob);
      if (gen !== estimateGeneration) {
        bitmap.close?.();
        return;
      }
      if (state.compressedBitmap?.close) state.compressedBitmap.close();
      state.compressedBitmap = bitmap;
      rerender();
      updateSizeEstimate();
    }
  } catch (err) {
    els.outputMetaSize.textContent = `Estimate failed: ${err.message || err}`;
    els.outputMetaSize.classList.remove("is-estimating");
    els.outputMetaSize.classList.add("is-error");
  } finally {
    estimateInFlight = false;
    if (gen !== estimateGeneration) {
      clearTimeout(estimateTimer);
      estimateTimer = setTimeout(runEstimate, 0);
    } else {
      setPreviewLoading(false);
    }
  }
}

function updateSizeEstimate() {
  if (!state.image) {
    updateOutputMeta();
    return;
  }
  updateOutputMeta();
}

function activateCropUi() {
  if (!state.image) return;
  modalState.active = true;
  modalState.crop = { ...state.crop };
  modalState.drag = null;
  modalState.removeCrop = false;
  modalState.focal = { ...state.focal };
  els.modal.hidden = false;
  els.modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    sizeModalCanvas();
    renderModal();
  });
}

function deactivateCropUi() {
  modalState.active = false;
  modalState.drag = null;
  modalState.removeCrop = false;
  modalState.focal = null;
  els.modal.hidden = true;
  els.modal.setAttribute("aria-hidden", "true");
}

function syncCropUiFromState() {
  if (!modalState.active) return;
  modalState.crop = { ...state.crop };
  modalState.focal = { ...state.focal };
  renderModal();
}

function sizeModalCanvas() {
  if (!state.image) return;
  const wrap = els.modalCanvas.parentElement;
  const maxW = Math.max(320, wrap.clientWidth);
  const maxH = Math.max(240, wrap.clientHeight);
  const aspect = state.image.width / state.image.height;
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  els.modalCanvas.width = Math.round(w);
  els.modalCanvas.height = Math.round(h);
  modalState.scale = w / state.image.width;
}

function renderModal() {
  if (!modalState.active || !state.image) return;
  const canvas = els.modalCanvas;
  const ctx = canvas.getContext("2d");
  const c = modalState.crop;
  const s = modalState.scale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(state.image.bitmap, 0, 0, canvas.width, canvas.height);

  if (c) {
    const cx = c.x * s;
    const cy = c.y * s;
    const cw = c.w * s;
    const ch = c.h * s;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, canvas.width, cy);
    ctx.fillRect(0, cy + ch, canvas.width, canvas.height - (cy + ch));
    ctx.fillRect(0, cy, cx, ch);
    ctx.fillRect(cx + cw, cy, canvas.width - (cx + cw), ch);
    ctx.restore();

    if (isGeneralMode()) {
      drawRuleOfThirds(ctx, { x: cx, y: cy, w: cw, h: ch });
    } else {
      drawModalCropSafeZone(ctx, { x: cx, y: cy, w: cw, h: ch }, s);
    }

    ctx.save();
    ctx.strokeStyle = "rgba(47, 129, 247, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
    const handles = modalHandlePositions(cx, cy, cw, ch);
    ctx.fillStyle = "rgba(47, 129, 247, 0.95)";
    const size = 10;
    const maxX = canvas.width - size;
    const maxY = canvas.height - size;
    for (const h of handles) {
      const dx = Math.min(Math.max(h.cx - size / 2, 0), maxX);
      const dy = Math.min(Math.max(h.cy - size / 2, 0), maxY);
      ctx.fillRect(dx, dy, size, size);
    }
    ctx.restore();
  }

  updateCropSizeWarning(c);
}

function updateCropSizeWarning(crop) {
  if (!crop) {
    els.cropSizeWarning.hidden = true;
    els.cropSizeWarningText.textContent = "";
    els.cropFixBtn.hidden = true;
    return;
  }

  const outputW = cropModalOutputWidth(crop.w, crop.h);
  const outputH = cropModalOutputHeight(crop.w, crop.h);
  const max = Math.max(outputW, outputH);

  // The suggested minimum is derived from the form layout, so it only means something
  // in background mode; general mode keeps just the "too large" warning.
  const suggestedMinW = isGeneralMode() ? 0 : Math.round((1920 - (state.settings.formWidth || 0)) / 100) * 100;
  const suggestedMinH = isGeneralMode() ? 0 : 1100;

  if (outputW < suggestedMinW || outputH < suggestedMinH) {
    els.cropSizeWarning.hidden = false;
    els.cropSizeWarningText.textContent = `Output is small (${outputW}×${outputH}). Suggested minimum: ${suggestedMinW}×${suggestedMinH}px.`;
    const canFix = state.image &&
      state.image.width >= suggestedMinW &&
      state.image.height >= suggestedMinH;
    els.cropFixBtn.hidden = !canFix;
  } else if (max > detailCap()) {
    els.cropSizeWarning.hidden = false;
    els.cropSizeWarningText.textContent = `Output is large (${outputW}×${outputH}). Recommended longest side: 1500–2000px.`;
    els.cropFixBtn.hidden = true;
  } else {
    els.cropSizeWarning.hidden = true;
    els.cropSizeWarningText.textContent = "";
    els.cropFixBtn.hidden = true;
  }
}

function fixCropToMeetMin() {
  if (!state.image) return;
  const fw = state.settings.formWidth || 0;
  const minW = Math.round((1920 - fw) / 100) * 100;
  const minH = 1100;
  if (state.image.width < minW || state.image.height < minH) return;

  const cropW = state.hasManualCrop && state.crop ? state.crop.w : state.image.width;
  const cropH = state.hasManualCrop && state.crop ? state.crop.h : state.image.height;

  // Step 1: try only bumping max-res. Works when current crop is already big enough
  // to satisfy the minimum once the cap is raised.
  if (cropW >= minW && cropH >= minH) {
    const intrinsicMax = Math.max(cropW, cropH);
    const requiredScale = Math.max(minW / cropW, minH / cropH);
    const requiredCap = Math.ceil(requiredScale * intrinsicMax);
    for (const preset of MAX_RES_PRESETS) {
      const presetCap = preset.value === 0 ? Infinity : preset.value;
      if (Math.min(presetCap, intrinsicMax) >= requiredCap) {
        state.maxResolution = preset.value;
        updateMaxResolutionDisplay();
        const clamped = clampOutputToCap();
        if (clamped) {
          syncOutputAndQualityToInputs();
          if (!state.hasManualCrop) recomputeCropFromFocal();
          persistImageState();
          scheduleEstimate();
        }
        rerender();
        if (modalState.active) renderModal();
        return;
      }
    }
  }

  // Step 2: bumping cap alone can't fix it (manual crop is smaller than min in
  // some dimension). Set max-res to "No limit" and expand the crop.
  state.maxResolution = 0;
  updateMaxResolutionDisplay();

  if (!state.hasManualCrop || !modalState.active || !modalState.crop) {
    if (clampOutputToCap()) {
      syncOutputAndQualityToInputs();
      if (!state.hasManualCrop) recomputeCropFromFocal();
      rerender();
      persistImageState();
      scheduleEstimate();
    }
    return;
  }

  const targetW = Math.min(state.image.width, Math.max(modalState.crop.w, minW));
  const targetH = Math.min(state.image.height, Math.max(modalState.crop.h, minH));
  const dw = targetW - modalState.crop.w;
  const dh = targetH - modalState.crop.h;
  const ef = effectiveFocal();
  let nx = modalState.crop.x - ef.x * dw;
  let ny = modalState.crop.y - ef.y * dh;
  if (nx < 0) nx = 0;
  if (ny < 0) ny = 0;
  if (nx + targetW > state.image.width) nx = state.image.width - targetW;
  if (ny + targetH > state.image.height) ny = state.image.height - targetH;
  modalState.crop = { x: nx, y: ny, w: targetW, h: targetH };
  commitModalCrop();
  syncCropUiFromState();
}

function drawModalCropSafeZone(ctx, rect, scale) {
  const safeZoneSettings = effectiveCropSafeZoneSettings();
  const isCenter = isCenterFormPosition();
  const refCrop = modalState.crop || state.crop;
  const cap = state.maxResolution > 0 ? state.maxResolution : Infinity;
  const refMax = refCrop ? Math.max(refCrop.w, refCrop.h) : 0;
  const outputW = refCrop
    ? (refMax <= cap ? refCrop.w : refCrop.w * cap / refMax)
    : 0;
  const safeZoneWidth = outputW > 0
    ? safeZoneSettings.safeZoneWidth * rect.w / outputW
    : 0;
  const warmZoneBandWidth = safeZoneWidth * (30 / 350);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.translate(rect.x, rect.y);
  const focalX = modalState.focal ? modalState.focal.x : effectiveFocal().x;
  drawActiveSafeZone(
    ctx,
    { width: rect.w, height: rect.h },
    safeZoneWidth,
    focalX,
    safeZoneSettings.safeZoneColor || "#00FF00",
    warmZoneBandWidth,
    safeZoneSettings.safeZoneFillAlpha,
    safeZoneSettings.safeZoneWarmColor
  );
  if (isCenter) {
    const colW = Math.round(Math.min(safeZoneWidth, rect.w));
    const x = Math.round((rect.w - colW) / 2);
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, 0, colW, rect.h);
  } else {
    drawFocalSectionCircle(
      ctx,
      { width: rect.w, height: rect.h },
      modalState.focal || effectiveFocal(),
      safeZoneSettings.safeZoneColor || "#00FF00",
      safeZoneSettings.safeZoneFillAlpha != null ? safeZoneSettings.safeZoneFillAlpha : 0.3,
      safeZonePosition(rect.w, safeZoneWidth, focalX),
      safeZoneWidth
    );
  }
  ctx.restore();
}

function cropModalOutputWidth(cropW, cropH) {
  const cap = detailCap();
  const max = Math.max(cropW, cropH);
  if (max <= cap) return cropW;
  return Math.max(1, Math.round(cropW * (cap / max)));
}

function cropModalOutputHeight(cropW, cropH) {
  const cap = detailCap();
  const max = Math.max(cropW, cropH);
  if (max <= cap) return cropH;
  return Math.max(1, Math.round(cropH * (cap / max)));
}

function modalHandlePositions(x, y, w, h) {
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

const HANDLE_CURSORS = {
  nw: "nw-resize",
  n: "n-resize",
  ne: "ne-resize",
  e: "e-resize",
  se: "se-resize",
  s: "s-resize",
  sw: "sw-resize",
  w: "w-resize",
  move: "grab",
};

function cursorForHandle(handle) {
  return HANDLE_CURSORS[handle] || "";
}

function modalHitTest(px, py) {
  const c = modalState.crop;
  if (!c) return null;
  const s = modalState.scale;
  const x = c.x * s, y = c.y * s, w = c.w * s, h = c.h * s;
  for (const h0 of modalHandlePositions(x, y, w, h)) {
    if (Math.abs(px - h0.cx) <= 8 && Math.abs(py - h0.cy) <= 8) return h0.name;
  }
  if (px >= x && px <= x + w && py >= y && py <= y + h) return "move";
  return null;
}

// The aspect the crop box is locked to, or null when dragging is unconstrained
// (background mode, or general mode with the "Free" ratio selected).
function generalCropAspect() {
  if (!isGeneralMode() || isFreeCrop()) return null;
  // In dimensions mode the target size is the constraint, whatever ratio it works out to.
  if (isDimensionsSizeMode()) {
    return state.outputH > 0 ? state.outputW / state.outputH : null;
  }
  const r = selectedAspect();
  return r ? r.w / r.h : null;
}

// clampCrop() pushes a crop back inside the image, which can flatten the aspect at an
// edge. Shrink the clamped box back to the locked aspect, keeping its center.
function constrainToAspect(crop, aspect) {
  if (!aspect) return crop;
  const current = crop.w / crop.h;
  if (Math.abs(current - aspect) / aspect < 0.001) return crop;
  let w = crop.w;
  let h = crop.h;
  if (current > aspect) w = h * aspect;
  else h = w / aspect;
  return {
    x: crop.x + (crop.w - w) / 2,
    y: crop.y + (crop.h - h) / 2,
    w,
    h,
  };
}

function applyDragFree(drag, dx, dy) {
  const { handle, startCrop } = drag;
  let { x, y, w, h } = startCrop;
  if (handle === "move") return { x: x + dx, y: y + dy, w, h };
  if (handle.includes("e")) w += dx;
  if (handle.includes("w")) { x += dx; w -= dx; }
  if (handle.includes("s")) h += dy;
  if (handle.includes("n")) { y += dy; h -= dy; }
  if (w < 20) { if (handle.includes("w")) x = startCrop.x + startCrop.w - 20; w = 20; }
  if (h < 20) { if (handle.includes("n")) y = startCrop.y + startCrop.h - 20; h = 20; }
  return { x, y, w, h };
}

function modalCanvasCoords(e, cachedRect) {
  const rect = cachedRect || els.modalCanvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (els.modalCanvas.width / rect.width);
  const py = (e.clientY - rect.top) * (els.modalCanvas.height / rect.height);
  return { px, py };
}

function commitModalCrop() {
  if (!state.image || !modalState.crop) return;
  const c = modalState.crop;
  if (c.w < 20 || c.h < 20) {
    syncCropUiFromState();
    return;
  }
  state.crop = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
  // In general mode a typed target survives a re-crop as long as the new crop still has
  // the same shape and enough pixels; otherwise the crop itself becomes the target.
  const keepTarget =
    isGeneralMode() &&
    Math.abs(state.outputW / state.outputH - state.crop.w / state.crop.h) / (state.crop.w / state.crop.h) < 0.005 &&
    state.outputW <= state.crop.w &&
    state.outputH <= state.crop.h;
  if (!keepTarget) {
    state.outputW = state.crop.w;
    state.outputH = state.crop.h;
    state.outputAspect = state.outputW / state.outputH;
  }
  state.hasManualCrop = !modalState.removeCrop;
  if (isGeneralMode()) {
    clampOutputToGeneral();
    // "Free" stays free: a free-form drag that happens to land near a common ratio
    // must not silently re-lock the crop box.
    if (!isFreeCrop()) {
      syncAspectFromDims();
      persistSettings();
    }
    updateRatioHint();
  } else {
    clampOutputToCap();
  }
  if (modalState.focal) {
    state.focal = { ...modalState.focal };
  }
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  updateFocalAttributeHint();
  updateRemoveCropVisibility();
  updateAutoSafeZoneColor();
  rerender();
  persistImageState();
  scheduleEstimate();
}

function nudgeCropByPreviewPx(dx, dy) {
  if (!state.image || !state.crop) return false;
  const mainW = els.canvas.width;
  const mainH = els.canvas.height;
  if (mainW <= 0 || mainH <= 0) return false;
  // Under contain fit the image occupies only part of the canvas, so a preview pixel
  // maps to a different number of source pixels than the cover fit's full-width draw.
  let sourceDx, sourceDy;
  if (isGeneralMode()) {
    const { scale } = containRect(els.canvas, state.crop, previewFitScale());
    sourceDx = dx / scale;
    sourceDy = dy / scale;
  } else {
    sourceDx = dx * (state.crop.w / mainW);
    sourceDy = dy * (state.crop.h / mainH);
  }
  let nx = state.crop.x + sourceDx;
  let ny = state.crop.y + sourceDy;
  let nw = state.crop.w;
  let nh = state.crop.h;
  const MIN_DIM = 20;

  if (nx < 0) {
    const excess = -nx;
    nx = 0;
    nw = Math.max(MIN_DIM, nw - excess);
  } else if (nx + nw > state.image.width) {
    const excess = (nx + nw) - state.image.width;
    nw = Math.max(MIN_DIM, nw - excess);
    nx = state.image.width - nw;
  }
  if (ny < 0) {
    const excess = -ny;
    ny = 0;
    nh = Math.max(MIN_DIM, nh - excess);
  } else if (ny + nh > state.image.height) {
    const excess = (ny + nh) - state.image.height;
    nh = Math.max(MIN_DIM, nh - excess);
    ny = state.image.height - nh;
  }

  if (nx === state.crop.x && ny === state.crop.y && nw === state.crop.w && nh === state.crop.h) return false;
  const cropResized = nw !== state.crop.w || nh !== state.crop.h;
  state.crop = { x: nx, y: ny, w: nw, h: nh };
  modalState.crop = { ...state.crop };
  state.hasManualCrop = true;
  if (cropResized) {
    state.outputW = state.crop.w;
    state.outputH = state.crop.h;
    state.outputAspect = state.outputW / state.outputH;
    clampOutputToCap();
  }
  syncOutputAndQualityToInputs();
  updateRemoveCropVisibility();
  updateAutoSafeZoneColor();
  rerender();
  if (modalState.active) renderModal();
  persistImageState();
  scheduleEstimate();
  return true;
}

function arrowKeyDelta(e) {
  let dx = 0, dy = 0;
  if (e.key === "ArrowLeft") dx = -1;
  else if (e.key === "ArrowRight") dx = 1;
  else if (e.key === "ArrowUp") dy = -1;
  else if (e.key === "ArrowDown") dy = 1;
  else return null;
  const mult = e.shiftKey ? 10 : 1;
  return { dx: dx * mult, dy: dy * mult };
}

function wireCropModal() {
  els.cropFixBtn.addEventListener("click", fixCropToMeetMin);

  els.modalCanvas.addEventListener("keydown", (e) => {
    if (!modalState.active) return;
    const delta = arrowKeyDelta(e);
    if (!delta) return;
    e.preventDefault();
    nudgeCropByPreviewPx(delta.dx, delta.dy);
  });

  els.modalCanvas.addEventListener("mousedown", (e) => {
    if (!modalState.active || !state.image) return;
    const rect = els.modalCanvas.getBoundingClientRect();
    const { px, py } = modalCanvasCoords(e, rect);
    const handle = modalHitTest(px, py);
    modalState.drag = {
      handle: handle || "new",
      startPx: px,
      startPy: py,
      startCrop: handle ? { ...modalState.crop } : null,
      moved: false,
      rect,
    };
    modalState.removeCrop = false;
    els.modalCanvas.style.cursor = handle === "move" ? "grabbing" : cursorForHandle(handle);
  });

  els.modalCanvas.addEventListener("mousemove", (e) => {
    if (modalState.drag || !modalState.active || !state.image) return;
    const { px, py } = modalCanvasCoords(e);
    const handle = modalHitTest(px, py);
    els.modalCanvas.style.cursor = cursorForHandle(handle);
  });

  els.modalCanvas.addEventListener("mouseleave", () => {
    if (modalState.drag) return;
    els.modalCanvas.style.cursor = "";
  });

  let dragRaf = 0;
  let pendingDragEvent = null;
  window.addEventListener("mousemove", (e) => {
    if (!modalState.drag || !modalState.active || !state.image) return;
    pendingDragEvent = e;
    if (dragRaf) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = 0;
      const ev = pendingDragEvent;
      pendingDragEvent = null;
      if (!ev || !modalState.drag || !modalState.active || !state.image) return;
      const { px, py } = modalCanvasCoords(ev, modalState.drag.rect);
      const dxPx = px - modalState.drag.startPx;
      const dyPx = py - modalState.drag.startPy;
      if (!modalState.drag.moved && Math.hypot(dxPx, dyPx) < 3) return;
      modalState.drag.moved = true;

      const lockedAspect = generalCropAspect();

      if (modalState.drag.handle === "new") {
        const ix = modalState.drag.startPx / modalState.scale;
        const iy = modalState.drag.startPy / modalState.scale;
        const dxImg = px / modalState.scale - ix;
        const dyImg = py / modalState.scale - iy;
        let w = Math.abs(dxImg);
        let h = Math.abs(dyImg);
        if (lockedAspect) {
          if (w / h > lockedAspect) w = h * lockedAspect;
          else h = w / lockedAspect;
        }
        modalState.crop = constrainToAspect(
          clampCrop(
            {
              x: dxImg < 0 ? ix - w : ix,
              y: dyImg < 0 ? iy - h : iy,
              w,
              h,
            },
            state.image
          ),
          lockedAspect
        );
      } else {
        const dx = dxPx / modalState.scale;
        const dy = dyPx / modalState.scale;
        const dragged = lockedAspect
          ? applyDrag(modalState.drag, dx, dy, lockedAspect)
          : applyDragFree(modalState.drag, dx, dy);
        modalState.crop = constrainToAspect(clampCrop(dragged, state.image), lockedAspect);
      }
      renderModal();
    });
  });

  window.addEventListener("mouseup", () => {
    if (!modalState.drag) return;
    const moved = modalState.drag.moved;
    modalState.drag = null;
    els.modalCanvas.style.cursor = "";
    if (moved) commitModalCrop();
  });

  window.addEventListener("resize", () => {
    if (modalState.active) {
      sizeModalCanvas();
      renderModal();
    }
  });
}

function wireUndoRedo() {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (!state.image) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undoHistory();
    } else if ((key === "y") || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      redoHistory();
    }
  });
}

function init() {
  const params = new URLSearchParams(window.location.search);
  // Free used to be stored as aspectRatio === "free"; migrate it to the separate flag so
  // the dropdown always holds a real ratio to fall back to.
  if (state.settings.aspectRatio === "free") {
    state.settings.freeCrop = true;
    state.settings.aspectRatio = "16:9";
  }
  applyUrlParams(params);
  if (!aspectRatioById(state.settings.aspectRatio)) {
    state.settings.aspectRatio = "16:9";
  }
  syncSettingsToInputs();
  applyModeUi();
  applyLayoutFromSettings();
  applySafeZoneColorVar();
  syncPresetUI();
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  wireSettingsInputs();
  wireImageInput();
  wireFocalAndCrop();
  wireCompression();
  wireCropModal();
  wireInfoModal();
  wireVideoModal();
  wireTestImageModal();
  wireUndoRedo();

  let resizeRaf = 0;
  const ro = new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      rerender();
    });
  });
  ro.observe(els.canvas.parentElement);

  rerender();

  // Publish the current configuration on load, not just on change, so the landing page
  // always carries a shareable link — including which mode is selected.
  syncUrlFromState();

  const srcParam = params.get("src");
  if (srcParam) attemptUrlLoad(srcParam);
}

init();
