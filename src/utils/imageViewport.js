// Pure view math for the image viewer (components/viewers/ViewerImage.vue).
//
// Every coordinate the viewer emits or draws — GCP and fiducial observations,
// residual vectors, guides, the mask canvas — lives in the image's NATIVE pixel
// frame (the original file's width × height; the frame keypoints, cameras and the
// reconstruction use). The <img> on screen is not always that size: while a TIFF
// transcodes, the store shows a ≤512 px preview first (stores/images/ingest.js),
// so the bitmap's naturalWidth can be ~20× smaller than the native frame. The view
// therefore works in native pixels throughout — `scale` is screen px per NATIVE px
// — and only the <img> transform and bitmap sampling convert to bitmap pixels.

// Pixel tolerance when checking that the record's native size has the displayed
// bitmap's aspect (a downscaled preview rounds each side to a whole pixel).
const ASPECT_TOL_PX = 1.5

/**
 * The native frame a displayed bitmap stands for.
 *
 * - naturalWidth/Height: the loaded <img>'s bitmap size.
 * - metaWidth/Height: the record's native size (`img.meta.width/height`) — may be
 *   null while metadata is still being read.
 * - lowRes: the store says `url` is the low-res transcode preview.
 *
 * Returns null before a bitmap has loaded, else
 * `{ width, height, naturalWidth, naturalHeight, bitmapScale, preview, exact }`:
 * - width/height: the frame the view works in (native px when `exact`);
 * - bitmapScale: bitmap px per frame px (1 for a full-resolution display);
 * - preview: only a reduced bitmap is shown — editing must wait for full res;
 * - exact: width/height ARE the native size, so native-pixel overlays and
 *   coordinates are meaningful. False only for a preview whose native size is not
 *   known yet; the view then shows the bitmap but must not map native pixels.
 */
export function imageFrame({ naturalWidth, naturalHeight, metaWidth, metaHeight, lowRes = false }) {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null
  const metaOk =
    metaWidth > 0 &&
    metaHeight > 0 &&
    Math.abs((naturalWidth * metaHeight) / metaWidth - naturalHeight) <= ASPECT_TOL_PX
  // A bitmap smaller than the recorded native size is a reduced copy even when the
  // store didn't flag it (belt and braces: the mapping must never assume 1:1 then).
  const reduced = metaOk && naturalWidth < metaWidth - 0.5
  const preview = !!lowRes || reduced
  const base = { naturalWidth, naturalHeight, preview }
  if (!preview) return { ...base, width: naturalWidth, height: naturalHeight, bitmapScale: 1, exact: true }
  if (metaOk)
    return { ...base, width: metaWidth, height: metaHeight, bitmapScale: naturalWidth / metaWidth, exact: true }
  return { ...base, width: naturalWidth, height: naturalHeight, bitmapScale: 1, exact: false }
}

/**
 * Fit a `width × height` frame into a `cw × ch` viewport (never upscaling past 1:1),
 * centred. Returns `{ scale, tx, ty }`, or null when either size is empty — a
 * v-show-hidden viewport measures 0×0, and fitting there would give scale 0 (and a
 * later zoom ±Infinity/NaN offsets). The caller must defer the fit instead.
 */
export function fitView(cw, ch, width, height) {
  if (!(cw > 0) || !(ch > 0) || !(width > 0) || !(height > 0)) return null
  const scale = Math.min(cw / width, ch / height, 1)
  return { scale, tx: (cw - width * scale) / 2, ty: (ch - height * scale) / 2 }
}

/**
 * Zoom `view` ({ scale, tx, ty }) by `factor` keeping viewport point (cx, cy) fixed,
 * with the new scale clamped to [min, max]. A view with no usable scale (0 / NaN —
 * never fitted) is returned unchanged rather than turned into non-finite offsets.
 */
export function zoomAbout(view, factor, cx, cy, min, max) {
  if (!(view.scale > 0) || !Number.isFinite(view.scale)) return view
  const scale = Math.min(max, Math.max(min, view.scale * factor))
  const ratio = scale / view.scale
  return { scale, tx: cx - (cx - view.tx) * ratio, ty: cy - (cy - view.ty) * ratio }
}

/**
 * Viewport point → frame pixel, clamped to the frame. Null when the frame is not
 * an exact native frame (a preview of unknown native size) — a pixel there would be
 * a preview pixel mislabelled as native.
 */
export function screenToImage(sx, sy, view, frame) {
  if (!frame?.exact || !(view.scale > 0)) return null
  return {
    px: Math.min(frame.width, Math.max(0, (sx - view.tx) / view.scale)),
    py: Math.min(frame.height, Math.max(0, (sy - view.ty) / view.scale)),
  }
}

/**
 * Frame pixel → the integer bitmap pixel holding it (for colour sampling). Per
 * axis: a preview's sides are rounded independently, so its aspect is only close.
 */
export function bitmapPixel(px, py, frame) {
  return {
    x: Math.min(frame.naturalWidth - 1, Math.max(0, Math.floor((px * frame.naturalWidth) / frame.width))),
    y: Math.min(frame.naturalHeight - 1, Math.max(0, Math.floor((py * frame.naturalHeight) / frame.height))),
  }
}
