# Background Image Helper

A single-page tool for prepping images for [ENgrid](https://github.com/4site-interactive-studios/engrid). Drop an image in and export an optimized WebP ready for upload.

## Two modes

A toggle on the landing page (and at the top of the settings panel once an image is loaded) picks the workflow:

- **Background image** (default) — the original workflow. Pick a preset for the campaign and the app visualizes how the form will sit on top of the image across viewports: safe zone, warm bands, focal point, and the matching ENgrid `data-background-position` attribute.
- **General image** — a plain crop-and-optimize helper with no form to simulate. Everything about safe zones, focal points, and presets is hidden. Instead you get a target width/height, an aspect-ratio dropdown of common ratios (16:9 by default) plus **Free**, and a readout of the actual ratio with a one-click link to snap to the nearest common one.

Target size is specified one of two ways, picked with a toggle so only the relevant controls are on screen: **Aspect ratio** (a dropdown of common ratios) or **Dimensions** (exact width/height inputs, up to five digits each, with a lock between them). A first look at an image picks the mode that describes it — one already sitting on a common ratio opens on that ratio, anything else opens on its own dimensions with the crop locked. Images with saved state keep whatever was chosen for them last time. Either way the crop box is locked to the resulting shape; unlocking it — the dropdown's **Free** entry or the lock icon — allows unconstrained dragging. It is one flag reached two ways, so the choice carries across a switch, and it is deliberately kept separate from the ratio value: dimensions that match no common ratio must not silently unlock the crop. Switching from Dimensions back to Aspect ratio pre-selects the matching ratio when the current size sits exactly on one.

Each axis caps independently against the source, so an over-large width leaves the height as typed rather than dragging it down proportionally. A capped value flashes its field and says which axis was limited and why — a rejected entry is otherwise indistinguishable from one the user typed.

The landing page has a slow drifting colour wash behind a frosted-glass card, built from [Josh Comeau's backdrop-filter write-up](https://www.joshwcomeau.com/css/backdrop-filter/). Two layers do the work: the blur layer is inset past the card on every side, because `backdrop-filter` only samples pixels directly behind its own box and would otherwise leave the edges visibly unblended; over it sits the **glassy edge**, a second backdrop layer with less blur and boosted brightness, masked to a thin rim so light reads as refracting at the edge of a thick pane rather than through its face. The drift stops under `prefers-reduced-motion: reduce`. A **Preview (2x)** row sits with Source and Output as a third reading of the same file — the size it occupies on screen. **On by default**, it previews the image at half its output dimensions and reports that as `1,200 × 675 (retina)`; switched off it reads `n/a`, since there is then no such size to report. The exported file keeps its full pixel dimensions either way; only the preview scale changes.

The download button names what you'll get — optimized or lossless WebP, or the original — and how the size moved: `Download optimized WebP (78% smaller)`, `Download lossless WebP (132% larger)`. A rounded 0% is left off, since no change is the plain reading there.

In general mode the preview shows the whole crop rather than a cover fit: it fills the width of the preview area when there's room, is never cropped, is never scaled past 1:1 of its own output pixels (or 0.5:1 with Retina on), and sits centered on black otherwise. The crop preview also carries rule-of-thirds guides for framing. The crop box is locked to the selected ratio (choose **Free** to drag unconstrained), and the output never upscales — a target larger than the cropped region is scaled back down to the pixels actually available. Downloads are suffixed `-optimized` instead of `-bg`.

The mode is remembered in `localStorage` and can be deep-linked with `?mode=general` or `?mode=background`.

## What it does

- Loads an image via **drop, click, paste, or URL** (JPEG / PNG / WebP). The landing page has an image-URL field — type or paste a URL there and it loads (debounced, or press Enter), matching the client's CDN prefix to auto-select their preset.
- Overlays a **safe zone** — the vertical column the form sits over — sized to a campaign preset or a custom width.
- Marks a **focal section indicator** (dashed circle) showing where the focal point lands inside the safe zone.
- Draws **warm zone bands** (five 30 px steps) on either side of the safe zone, previewing how the image holds up as the form's edge moves at different viewport widths.
- Auto-picks the highest-contrast color from a fixed 6-color palette (red, orange, yellow, green, blue, indigo), or lets you cycle through them manually.
- Re-crops to the chosen focal point (Left/Center/Right × Top/Center/Bottom) with arrow-key nudging.
- Exports as WebP with selectable max resolution and quality, encoded off the main thread in a Web Worker. Setting **No limit** and **Maximum quality** together switches the encoder to lossless WebP at full resolution — the quality readout reads "Lossless" to make that visible. Lossless output is expected to exceed a JPEG source, so the usual "hand back the original when the re-encode is larger" substitution is skipped there; it was asked for explicitly.
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

### `?mode=general` / `?mode=background`

Opens the app in the given mode and persists that choice, so a general-image link can be shared directly. Combines with `?src=`.

### Shareable settings links

Changing a setting rewrites the query string in place (`history.replaceState`, no navigation), so the address bar always holds a link that reproduces the current view.

When the image itself came from a link — pasted, or arriving via `?src=` — it travels too, along with the crop rectangle, so the recipient opens on the same image framed the same way. Local files can't be re-fetched by anyone else, so those links carry only the settings and open on the landing page, applying them to whatever the recipient loads.

Parameters written and read back: `src`, `crop` (`x,y,w,h` in source-image pixels), `focal` (background mode, where it places the safe zone), `mode`, `size` (`aspect`/`dimensions`), `ratio`, `free`, `w`/`h`, `retina`, `preset` (plus `layout`, `formwidth`, `safezone` when the preset is custom), `maxres`, and `quality`. `debug` is preserved rather than overwritten.

A hand-written link may omit `size`: naming a `ratio` implies aspect mode and a `w`/`h` pair implies dimensions, so the mode never falls back to whatever happens to be in local storage. An explicit `size` always wins.

`src` is written from state rather than passed through, so replacing the image replaces the link instead of stranding the previous one.

`crop` is the one parameter tied to a particular image rather than being a setting: it is in that image's pixels, so it is applied only when the image that loads is the one `src` named. Open a link and then upload something of your own and every setting carries over while the crop is discarded, framing the new image fresh. For the same reason `crop` is only written alongside a `src` — without one it would describe a frame nobody else can reach.

`w`/`h`, `crop`, `focal`, `maxres`, and `quality` can only take effect once an image exists, so they are held and applied on first load — `applyImage()` would otherwise reset max resolution and quality to their per-image defaults. The crop lands last and overrides whatever framing the mode would have derived, since reproducing it is the point of the link. Because those values settle late, `applyImage()` re-syncs the URL when it finishes; syncs earlier in the same load describe a frame that no longer exists. The sync is cosmetic and fully guarded, so a failure can never break the settings change that triggered it. Note it must call `window.history.replaceState` explicitly: `js/app.js` declares its own `const history` for undo/redo, which shadows the global for the whole module, and a bare `history.replaceState` there silently resolves to that object instead.

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

- **Settings** — mode, aspect ratio, Retina, preset, form width, safe zone, color mode, etc. Restored on every page load.
- **Per-image state** — crop frame, focal point, output dimensions, quality, keyed by a hash of the image bytes. So re-loading the same image restores your prior crop/focal choices. Capped at 50 images (LRU-pruned).

The image bytes themselves are **not** persisted — refreshing the page drops the loaded image and shows the empty state. Use **Clear image** to drop the current image without reloading.

## Keyboard

- Click the preview to focus it, then **arrow keys** nudge the crop one preview-pixel at a time.
- Hold **Shift** to nudge by 10 pixels.
- **Paste** an image (or an `http(s)://` image URL) from anywhere on the page.

## Browser support

Requires a modern browser: ES modules, Web Workers, `createImageBitmap`, `OffscreenCanvas` (used in the encode worker), and Clipboard / DataTransfer APIs. Tested on current Chrome and Safari.
