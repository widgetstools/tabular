# Running tabular under OpenFin

Tabular is a canvas grid: every painted pixel is produced by JavaScript on the
renderer main thread. Desktop Chrome hides that cost behind a fast CPU and GPU
rasterization. OpenFin deployments routinely take both away, which is why a
grid that is silky in Chrome can feel janky in the container. This doc explains
the mechanics and gives the configuration that matters.

## Why OpenFin degrades canvas rendering

1. **Pinned, older Chromium.** OpenFin manifests pin an exact
   `runtime.version`; bank change-control tends to freeze it for quarters. The
   newest stable runtime already trails desktop Chrome by ~4 Chromium majors;
   a runtime pinned a year ago trails by 12–20, missing every raster and
   compositing improvement in the gap. Check the second segment of the runtime
   version — it is the Chromium major (e.g. `44.146.x` → Chromium 146).

2. **Software rasterization.** In VDI/Citrix environments — and on any desk
   where `--disable-gpu` was pushed fleet-wide via the registry
   (`HKCU\Software\OpenFin\RVM\runtimeArgs`) — Chromium composites and
   rasterizes on the CPU. Canvas 2D loses its GPU backing entirely, so cost
   becomes linear in painted pixels, on one core. A DOM grid (ag-grid) degrades
   more gracefully there because Chromium caches its painted layers as tiles
   and scrolls them on the compositor; an immediate-mode canvas repaints
   through JS every frame. Tabular's scroll-blit fast path (see below) closes
   most of that gap, but pixel volume still matters.

3. **Occlusion and background throttling.** Financial workspaces stack
   windows. Chromium marks a fully covered window as hidden — rAF stops, and
   the grid appears frozen when re-exposed. OpenFin Views in hidden tabs get
   **no rAF at all** and this cannot be disabled for Views.

4. **Transparency effects.** OpenFin's `alphaMask` window option requires
   `--disable-gpu --allow-unsafe-compositing` — one legacy window using it
   puts every window sharing the runtime on CPU rendering. Do not use it.
   (`cornerRounding` is fine; whole-window `opacity` is fine only with GPU
   compositing intact.)

## What the grid does about it

The core engine is tuned for CPU-constrained rendering out of the box:

- **Scroll blitting** — on a pure vertical scroll the previous frame's pixels
  are shifted with one `drawImage` and only the newly exposed rows are
  repainted (O(scrolled-in cells) instead of O(viewport cells)). Measured under
  6× CPU throttling on the 100k-row showcase: 23 fps → ~51 fps, per-frame
  `fillText` calls 326 → ~50. The fast path disables itself automatically
  whenever anything but scroll position changed (data ticks, selection, flash
  animation, sticky group headers, merged row spans, fractional device-pixel
  deltas).
- **Static canvases skipped** — the header and pinned-row canvases are not
  repainted on vertical-only scroll frames.
- **Opaque layers** — header/body/pinned contexts are created with
  `{ alpha: false }`, letting the compositor skip per-pixel blending of those
  layers (a pure win under software compositing).
- **No backing-store churn** — canvas width/height are only assigned when they
  actually change (assignment reallocates and wipes the backing store).
- **DPI changes observed** — a `matchMedia('(resolution: …dppx)')` re-arm loop
  re-renders crisply when the window moves between monitors with different
  scale factors (multi-monitor trading desks).

## Running the showcase in OpenFin

```bash
npm run dev:showcase       # vite on :5173 (serves the manifest too)
npm run openfin:showcase   # launches the OpenFin window via @openfin/node-adapter
```

The manifest lives at `apps/showcase/public/openfin/app.json` (served as
`http://localhost:5173/openfin/app.json`) and pins a runtime version. Pin one
that exists under `~/Openfin/Runtime/` — on Apple Silicon it must be an arm64
build (`file .../OpenFin.app/Contents/MacOS/OpenFin`); an x86_64 runtime dies
silently at spawn (the RVM logs `PID: 0xFFFFFFFF`).

The runtime exposes DevTools on port 9092 (`devtools_port` +
`--remote-debugging-port` in the manifest): open `chrome://inspect`, add
`localhost:9092`, or hit `http://localhost:9092/json/list` directly.

**Gotcha — launching from inside an editor/agent terminal:** VS Code/Cursor
extension hosts export `ELECTRON_RUN_AS_NODE=1`. If that leaks into the
launcher's environment, the OpenFin runtime (an Electron binary) starts as
plain Node, prints `bad option: --startup-url=…`, and exits instantly — the
RVM still reports the app as "successfully loaded". Launch with
`env -u ELECTRON_RUN_AS_NODE npm run openfin:showcase` from such terminals.

## App-side configuration

### Detect software rendering and cap the pixel budget

Painted-pixel cost under software raster is linear in `dpr²`. On a detected
software-rendered machine, cap the canvas scale:

```ts
function softwareRasterLikely(): boolean {
  const gl = document.createElement('canvas').getContext('webgl');
  if (!gl) return true; // Chromium ≥ ~137 refuses WebGL without a GPU
  const renderer = String(gl.getParameter(gl.RENDERER));
  return /swiftshader|llvmpipe|software/i.test(renderer);
}

new Tabular(host, {
  ...options,
  // 2x → 1x is a 4× raster saving; text is slightly softer.
  maxDevicePixelRatio: softwareRasterLikely() ? 1 : undefined,
});
```

### Manifest

```json
{
  "runtime": {
    "version": "<track the newest stable — the version's 2nd segment is the Chromium major>",
    "arguments": "--disable-features=CalculateNativeWinOcclusion"
  },
  "platform": {
    "defaultWindowOptions": {
      "backgroundThrottling": false,
      "throttling": "scheduler-disabled"
    },
    "defaultViewOptions": {
      "throttling": "scheduler-disabled"
    }
  }
}
```

- `throttling: 'disabled'` (paint + timers at full speed while occluded) only
  on windows that genuinely must keep painting — tickers, alert strips. Use
  `'scheduler-disabled'` elsewhere: data keeps flowing, paint pauses, and the
  grid repaints in one frame on re-expose.
- Hidden **Views** never receive rAF regardless of settings. Tabular handles
  this: the next paint after re-show is a full repaint (the blit path
  validates its previous-frame state). Don't add your own "keep-alive" rAF
  loops in views.
- If desks still report freezes when windows overlap, add
  `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
  to `runtime.arguments`.
- Audit `HKCU\Software\OpenFin\RVM\runtimeArgs` on complaint machines: a
  registry-pushed `--disable-gpu` silently applies to every OpenFin app on the
  box. If GPU must stay off (VDI), pair it with `--disable-software-rasterizer`
  per OpenFin's guidance and ship the `maxDevicePixelRatio: 1` profile above.
- Never use `alphaMask`; avoid whole-window `opacity` in software-composited
  environments.

## Things that still cost more than they should

Known follow-ups that would further improve worst-case (non-scroll) frames:

- Tick flash keeps a full-repaint rAF loop alive for the flash duration; a
  damage-rect limited to flashed cells would cut sustained repaint cost in
  dense blotters.
- `env()` rebuilds a large paint-environment object per frame (and per
  hit-test); caching it per model/layout generation would remove steady-state
  allocation churn.
- Sticky group headers disable the scroll blit (they are
  viewport-position-dependent). Grids that don't need them can set
  `groupSticky: false` to keep the fast path while grouped.
