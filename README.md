# Background Image Helper

A single-page tool for prepping background images for [ENgrid](https://github.com/4site-interactive-studios/engrid) form layouts. Drop an image in, pick a preset for the campaign, and the app visualizes how the form will sit on top of it across viewports — then exports an optimized WebP ready for upload.

## What it does

- Loads an image via **drop, click, paste, or URL** (JPEG / PNG / WebP). The landing page has an image-URL field — type or paste a URL there and it loads (debounced, or press Enter), matching the client's CDN prefix to auto-select their preset.
- Overlays a **safe zone** — the vertical column the form sits over — sized to a campaign preset or a custom width.
- Marks a **focal section indicator** (dashed circle) showing where the focal point lands inside the safe zone.
- Draws **warm zone bands** (five 30 px steps) on either side of the safe zone, previewing how the image holds up as the form's edge moves at different viewport widths.
- Auto-picks the highest-contrast color from a fixed 6-color palette (red, orange, yellow, green, blue, indigo), or lets you cycle through them manually.
- Re-crops to the chosen focal point (Left/Center/Right × Top/Center/Bottom) with arrow-key nudging.
- Exports as WebP with selectable max resolution and quality, encoded off the main thread in a Web Worker.
- Side-by-side **Compare** view of source vs. output.

## Presets

| Preset | Form position | Form width | Safe zone |
|---|---|---|---|
| AIUSA - Left † | Left | 550 | 350 |
| NGS - Left | Left | 550 | 350 |
| NWF - Left | Left | 800 | 200 |
| Oceana - Left | Left | 680 | 350 |
| RAN - Left | Left | 680 | 300 |
| Shatterproof - Left | Left | 640 | 350 |
| TPL - Left | Left | 768 | 350 |
| WWF - Center | Center | 1200 | 1200 |
| Custom | any | any | any |

† AIUSA dimensions are placeholders — confirm and update the entry in `PRESETS` in `js/app.js` once known.

Custom mode unlocks the form-width and safe-zone inputs.

### Smart preset selection

When an image URL is entered in the landing page's **image URL** field, pasted anywhere on the page, or passed via `?src=`, the URL is matched against a list of known client CDN prefixes (`CLIENT_URL_PATTERNS` in `js/app.js`). On match, the client's preset is auto-selected and the dropdown is filtered to show only that client's preset + Custom, before the image finishes loading. Currently mapped:

| URL prefix | Preset |
|---|---|
| `https://c27fdabe952dfc357fe25ebf5c8897ee.ssl.cf5.rackcdn.com/1839/` | AIUSA - Left |
| `https://acb0a5d73b67fccd4bbe-c2d8138f0ea10a18dd4c43ec3aa4240a.ssl.cf5.rackcdn.com/10033/` | NWF - Left |
| `https://bd6ca9cefa6fb6e0adf1-c2f9aa1adb9f60a775f60074e4c86031.ssl.cf5.rackcdn.com/20002/` | TPL - Left |

For first-time users (nothing persisted in localStorage), uploading an image with no client URL match defaults to **Custom** rather than the displayed default. Once a user picks any preset, that choice sticks for future sessions.

## Running locally

It's a static site. Any HTTP server works. The repo ships a `.claude/launch.json` configured for:

```
python3 -m http.server 8765
```

Then visit http://localhost:8765/.

Opening `index.html` directly via `file://` will fail — the app uses ES modules and a Web Worker, both of which require an `http(s)://` origin.

## Auto color

When the safe-zone color is set to **Auto**, the app re-picks the outline color whenever the image, crop, focal point, or safe-zone width changes:

1. Sample the area covered by the safe zone, downscale to 8×8, average the RGB.
2. Score each of the 6 palette colors against the avg:
   - Primary: Euclidean RGB distance (largest wins).
   - Tie-breaker: perceptual luma difference using ITU-R BT.601 weights (`0.299·R + 0.587·G + 0.114·B`). This separates Red/Green/Blue when they tie on raw distance (e.g. against pure white, where Blue wins on luma).
3. Pick the top-ranked palette color.
4. Debounced 150 ms so rapid changes coalesce.

Sample picks: white → Blue, black → Yellow, grey → Blue, red → Green, blue → Yellow.

### `?debug=true`

Append `?debug=true` to the URL to log each auto-color recompute:

```
[auto-color] safe zone color: #FFFFFF → overlay color: #0000FF
  { pickedName: "Blue",
    candidates: [
      { color: "#0000FF", name: "Blue",   distance: 441, lumaDiff: 226 },
      { color: "#FF0000", name: "Red",    distance: 360, lumaDiff: 179 },
      ...
    ],
    unchanged: false }
```

The first hex is the sampled image avg, the second is the chosen palette color. `unchanged: true` means the picker ran but produced the same color it already had. The `candidates` array shows the full ranking.

### `?src=<URL>`

Append `?src=https://...` to auto-load an image URL on page open. Subject to CORS for cross-origin images (same as paste-URL).

### CMD/Ctrl+click on the upload icon

Opens a "Pick a test image" modal with 10 synthetic test patterns (solid Black/White/Grey/R/G/B, B/W stripes vertical & horizontal, rainbow stripes vertical & horizontal) generated on the fly as 4000×3000 JPEGs. Useful for sanity-checking the safe-zone overlay and the auto-color picker against known inputs.

Holding CMD/Ctrl when clicking the upload icon **also enables debug mode** for the rest of the session, even if `?debug=true` isn't in the URL.

## File layout

```
index.html              # entry — single page, no router
css/styles.css          # all styling
js/
  app.js                # UI wiring, state, settings persistence, auto-color
  imagework.js          # decode, crop math, source-image setup
  overlay.js            # canvas rendering — safe zone, warm bands, focal circle
  compress.js           # download trigger, filename suggestion
  encode-client.js      # main-thread side of WebP encoding
  encode-worker.js      # Web Worker — actual WebP encode
  storage.js            # localStorage persistence (settings + per-image state)
assets/                 # logo, favicons, overview video
.claude/launch.json     # dev-server config
```

Each module import in `app.js` carries a `?v=N` cache buster; bump the relevant one when changing a module so users don't get a stale copy. The `<script>` tag in `index.html` has its own version for `app.js`.

## Persistence

Two things are stored in `localStorage` under `engrid-bg-viz`:

- **Settings** — preset, form width, safe zone, color mode, etc. Restored on every page load.
- **Per-image state** — crop frame, focal point, output dimensions, quality, keyed by a hash of the image bytes. So re-loading the same image restores your prior crop/focal choices. Capped at 50 images (LRU-pruned).

The image bytes themselves are **not** persisted — refreshing the page drops the loaded image and shows the empty state. Use **Clear image** to drop the current image without reloading.

## Keyboard

- Click the preview to focus it, then **arrow keys** nudge the crop one preview-pixel at a time.
- Hold **Shift** to nudge by 10 pixels.
- **Paste** an image (or an `http(s)://` image URL) from anywhere on the page.

## Browser support

Requires a modern browser: ES modules, Web Workers, `createImageBitmap`, `OffscreenCanvas` (used in the encode worker), and Clipboard / DataTransfer APIs. Tested on current Chrome and Safari.
