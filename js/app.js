import { loadSettings, saveSettings, loadImageState, saveImageState } from "./storage.js?v=34";
import {
  loadFromFile,
  loadFromUrl,
  computeCropFromFocalPoint,
  clampCrop,
  cropToImageData,
  formatBytes,
} from "./imagework.js?v=33";
import { fitCanvasToContainer, render, drawActiveSafeZone, drawFocalSectionCircle, safeZonePosition } from "./overlay.js?v=44";
import { triggerDownload, suggestFilename } from "./compress.js?v=32";
import { encodeWebpInWorker } from "./encode-client.js?v=2";

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
  if (!state.settings.safeZoneAuto || !state.image) return;
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
};

const els = {
  layout: document.querySelector(".layout"),
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
  commitHistory();
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
  applyLayoutFromSettings();
  applySafeZoneColorVar();
  syncPresetUI();
  syncOutputAndQualityToInputs();
  updateRemoveCropVisibility();
  highlightFocalPreset();
  updateFocalAttributeHint();
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
  document.documentElement.style.setProperty("--form-width", `${state.settings.formWidth}px`);
  els.layout.classList.remove("form-pos-left", "form-pos-center", "form-pos-right");
  els.layout.classList.add(`form-pos-${state.settings.layout}`);
  updateCenterModeControls();
  highlightFocalPreset();
}

function isCenterFormPosition() {
  return state.settings.layout === "center";
}

function updateCenterModeControls() {
  const isCenter = isCenterFormPosition();
  els.safeZoneSetting.hidden = isCenter;
  els.focalPointSetting.hidden = isCenter;
  if (els.cropFocalSetting) els.cropFocalSetting.hidden = isCenter;
  updateFocalAttributeHint();
}

function updateFocalAttributeHint() {
  if (!state.image) {
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
  return isCenterFormPosition() ? { x: 0.5, y: 0.5 } : state.focal;
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

function updateQualityDisplay() {
  const idx = nearestPresetIndex(QUALITY_PRESETS, state.quality);
  els.quality.value = String(idx);
  if (els.qualityVal) els.qualityVal.textContent = QUALITY_PRESETS[idx].label;
}

function updateMaxResolutionDisplay() {
  const idx = state.maxResolution === 0
    ? MAX_RES_PRESETS.findIndex(p => p.value === 0)
    : nearestPresetIndex(MAX_RES_PRESETS.filter(p => p.value > 0), state.maxResolution);
  els.maxResolution.value = String(idx);
  if (els.maxResolutionVal) els.maxResolutionVal.textContent = MAX_RES_PRESETS[idx].label;
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

function updateDownloadLabel() {
  if (!els.download) return;
  els.download.textContent = state.usingSource ? "Download original" : "Download optimized WebP";
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
  if (state.hasManualCrop && state.crop && state.image) {
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

  state.maxResolution = 2500;
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
    state.quality = 55;
    state.crop = computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  }

  state.outputAspect = state.outputW / state.outputH;
  updateMaxResolutionDisplay();
  clampOutputToCap();
  if (!state.hasManualCrop) {
    state.crop = computeCropFromFocalPoint(image, effectiveFocal(), state.outputW, state.outputH);
  }
  syncOutputAndQualityToInputs();
  highlightFocalPreset();
  updateFocalAttributeHint();
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
}

function handleClearImage() {
  state.image = null;
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
  rerender();
  resetHistory();
}

async function handleFile(file) {
  clearError();
  clearClientPresetFilter();
  applyCustomDefaultIfUnset();
  const gen = ++loadGeneration;
  try {
    const image = await loadFromFile(file);
    if (gen !== loadGeneration) return;
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

  els.outputW.addEventListener("input", () => {
    state.outputW = clampInt(els.outputW.value, 100, 6000, state.outputW);
    state.outputH = Math.max(1, Math.round(state.outputW / state.outputAspect));
    els.outputH.value = state.outputH;
    updateOutputDimensionLabels();
      if (state.image) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
  });
  els.outputH.addEventListener("input", () => {
    state.outputH = clampInt(els.outputH.value, 100, 6000, state.outputH);
    state.outputW = Math.max(1, Math.round(state.outputH * state.outputAspect));
    els.outputW.value = state.outputW;
    updateOutputDimensionLabels();
      if (state.image) recomputeCropFromFocal();
    rerender();
    persistImageState();
    scheduleEstimate();
  });

  els.maxResolution.addEventListener("input", () => {
    const idx = clampInt(els.maxResolution.value, 0, MAX_RES_PRESETS.length - 1, 0);
    state.maxResolution = MAX_RES_PRESETS[idx].value;
    updateMaxResolutionDisplay();
    if (!state.image) return;
    const changed = clampOutputToCap();
    if (changed) syncOutputAndQualityToInputs();
    debouncedSliderEffects(() => {
      if (changed && !state.hasManualCrop) recomputeCropFromFocal();
      rerender();
      if (modalState.active) renderModal();
      updateAutoSafeZoneColor();
      if (changed) {
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
        suggestFilename(state.image.filename, state.image.mimeType),
        state.image.mimeType
      );
      return;
    }
    if (state.encodedBytes) {
      triggerDownload(
        state.encodedBytes,
        suggestFilename(state.image.filename, "image/webp"),
        "image/webp"
      );
      return;
    }
    els.download.disabled = true;
    const oldText = els.download.textContent;
    els.download.textContent = "Encoding…";
    try {
      const imageData = cropToImageData(state.image, state.crop, state.outputW, state.outputH);
      const bytes = await encodeWebpInWorker(imageData, state.quality);
      state.encodedBytes = bytes;
      state.estimatedBytes = bytes.byteLength;
      triggerDownload(bytes, suggestFilename(state.image.filename, "image/webp"), "image/webp");
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
    const bytes = await encodeWebpInWorker(imageData, state.quality);
    if (gen !== estimateGeneration) return;
    const isFullSize = !state.hasManualCrop &&
      state.outputW >= state.image.width &&
      state.outputH >= state.image.height;
    state.usingSource = isFullSize && bytes.byteLength > state.image.byteLength;
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

    drawModalCropSafeZone(ctx, { x: cx, y: cy, w: cw, h: ch }, s);

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

  const suggestedMinW = Math.round((1920 - (state.settings.formWidth || 0)) / 100) * 100;
  const suggestedMinH = 1100;

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
  state.outputW = state.crop.w;
  state.outputH = state.crop.h;
  state.outputAspect = state.outputW / state.outputH;
  state.hasManualCrop = !modalState.removeCrop;
  clampOutputToCap();
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
  const sourceDx = dx * (state.crop.w / mainW);
  const sourceDy = dy * (state.crop.h / mainH);
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

      if (modalState.drag.handle === "new") {
        const ix = modalState.drag.startPx / modalState.scale;
        const iy = modalState.drag.startPy / modalState.scale;
        const dxImg = px / modalState.scale - ix;
        const dyImg = py / modalState.scale - iy;
        modalState.crop = clampCrop(
          {
            x: dxImg < 0 ? ix + dxImg : ix,
            y: dyImg < 0 ? iy + dyImg : iy,
            w: Math.abs(dxImg),
            h: Math.abs(dyImg),
          },
          state.image
        );
      } else {
        const dx = dxPx / modalState.scale;
        const dy = dyPx / modalState.scale;
        modalState.crop = clampCrop(
          applyDragFree(modalState.drag, dx, dy),
          state.image
        );
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
  syncSettingsToInputs();
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

  const srcParam = new URLSearchParams(window.location.search).get("src");
  if (srcParam) attemptUrlLoad(srcParam);
}

init();
