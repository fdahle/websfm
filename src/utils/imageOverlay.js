// Pure painters for the image viewer's overlay canvas (components/viewers/
// ViewerImage.vue). Each takes the 2D context, the current `view` and its own
// data, and draws one layer; the component's renderOverlay decides which layers
// are on and in what order (later layers draw on top).
//
// `view` (see overlayView) is the frame of one repaint, in CSS px:
//   { w, h }        viewport size;
//   { tx, ty }      screen position of the image's top-left corner;
//   scale           screen px per NATIVE image px;
//   { nw, nh }      the native frame (utils/imageViewport.js `frame.width/height`);
//   { dispW, dispH} on-screen image size (nw·scale × nh·scale).
// Native-pixel data (GCPs, guides, residuals, fiducials) maps through nw/nh, never
// the displayed bitmap's size — they differ while a TIFF preview is shown.
//
// The arithmetic is deliberately the exact expression each layer always used
// ((px / nw) · dispW + tx, not px · scale + tx): the same floats, the same pixels.
// No DOM here beyond the context API (and Path2D for keypoints), so a recording
// fake context can test each painter in node.

import { depthColor } from '../core/products/colormap.js'

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

/** The view of one repaint: viewport `w × h`, pan `tx/ty`, `scale`, native `frame`. */
export function overlayView({ w, h, tx, ty, scale, frame }) {
  return {
    w, h, tx, ty, scale,
    nw: frame.width, nh: frame.height,
    dispW: frame.width * scale, dispH: frame.height * scale,
  }
}

/**
 * Size the overlay canvas to the viewport at device resolution (only when it
 * changed — resizing clears it) and return its context, transformed to CSS px and
 * cleared.
 */
export function beginOverlayFrame(canvas, w, h, dpr) {
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width  = pw
    canvas.height = ph
    canvas.style.width  = `${w}px`
    canvas.style.height = `${h}px`
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return ctx
}

// ── Legends ───────────────────────────────────────────────────────────────────
// Colour legends stack up from the bottom-left corner; `slot` (0-based) is the
// row, one per active overlay, so successive legends don't overlap.

// Legend colour ramps as [offset, cssColor] stops.
export const KEYPOINT_LEGEND = {
  stops: [
    [0,   'hsl(240,100%,55%)'],
    [0.5, 'hsl(120,100%,55%)'],
    [1,   'hsl(0,100%,55%)'],
  ],
  left: 'low', right: 'high', title: 'response',
}
// Sample the depth ramp (core/colormap depthColor) at a few points for the gradient.
export const DEPTH_LEGEND = {
  stops: [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const [r, g, b] = depthColor(t)
    return [t, `rgb(${r},${g},${b})`]
  }),
  left: 'near', right: 'far', title: 'depth',
}

/** A labelled colour-ramp legend (`legend`: { stops, left, right, title }) in row `slot`. */
export function paintRampLegend(ctx, view, slot, { stops, left, right, title }) {
  const LW = 72, LH = 8, ROW = 34
  const LX = 12
  const LY = view.h - 36 - slot * ROW
  ctx.save()
  const grad = ctx.createLinearGradient(LX, 0, LX + LW, 0)
  for (const [offset, color] of stops) grad.addColorStop(offset, color)
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(LX - 4, LY - 14, LW + 8, LH + 22)
  ctx.fillStyle = grad
  ctx.fillRect(LX, LY, LW, LH)
  ctx.font = '9px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.textAlign = 'left'
  ctx.fillText(left, LX, LY + LH + 10)
  ctx.textAlign = 'right'
  ctx.fillText(right, LX + LW, LY + LH + 10)
  ctx.textAlign = 'center'
  ctx.fillText(title, LX + LW / 2, LY - 3)
  ctx.restore()
}

/** Caption for the residual overlay in row `slot`: the ×25 amplification + colour meaning. */
export function paintResidualLegend(ctx, view, slot) {
  const ROW = 34, LX = 12, LY = view.h - 36 - slot * ROW
  ctx.save()
  const text = '×25  red > 2 px'
  ctx.font = '9px sans-serif'
  const tw = ctx.measureText(text).width
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(LX - 4, LY - 6, tw + 8, 16)
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.textAlign = 'left'
  ctx.fillText(text, LX, LY + 5)
  ctx.restore()
}

// ── Raster layers (depth, mask, Smart Select candidate) ──────────────────────

/**
 * Blit an image-registered raster (any size — it is stretched over the image's
 * on-screen rect) at `alpha`. `smooth` turns smoothing on, for a low-res source.
 */
export function paintRaster(ctx, view, source, alpha, { smooth = false } = {}) {
  ctx.save()
  if (smooth) ctx.imageSmoothingEnabled = true
  ctx.globalAlpha = alpha
  ctx.drawImage(source, view.tx, view.ty, view.dispW, view.dispH)
  ctx.restore()
}

// ── Keypoints ─────────────────────────────────────────────────────────────────

/**
 * Response range of a typed keypoint set (core/features/keypoints.js), for the
 * cold→hot ramp: `{ minR, range }` (range never 0), or null for an empty set.
 */
export function keypointResponseRange(kps) {
  if (!kps?.length) return null
  let minR = Infinity, maxR = -Infinity
  for (let i = 0; i < kps.length; i++) {
    const r = kps.response(i)
    if (r < minR) minR = r
    if (r > maxR) maxR = r
  }
  return { minR, range: maxR - minR || 1 }
}

/**
 * Keypoints as colour-coded dots (cold = blue → hot = red by response). `kps` is a
 * typed set with normalized nx/ny; `range` is keypointResponseRange(kps).
 */
export function paintKeypoints(ctx, view, kps, { minR, range }) {
  const { w, h, dispW, dispH } = view
  // Batched into one Path2D per hue bucket. A `fillStyle` change flushes the 2D
  // context, so a per-point colour costs one state change per keypoint — with
  // tens of thousands of them that dominates a drag frame. 24 buckets is finer
  // than the eye resolves on a 4 px dot.
  const BUCKETS = 24
  const paths = new Array(BUCKETS)
  const R = 2, edge = R + 1
  const ox = view.tx, oy = view.ty
  for (let i = 0; i < kps.length; i++) {
    const x = kps.nx(i) * dispW + ox
    const y = kps.ny(i) * dispH + oy
    // Cull off-screen points: zoomed in, that is nearly all of them.
    if (x < -edge || y < -edge || x > w + edge || y > h + edge) continue
    const t = (kps.response(i) - minR) / range  // 0 = coldest, 1 = hottest
    const b = clamp(Math.round(t * (BUCKETS - 1)), 0, BUCKETS - 1)
    const p = paths[b] ?? (paths[b] = new Path2D())
    p.moveTo(x + R, y)                          // arc start, so no joining line
    p.arc(x, y, R, 0, Math.PI * 2)
  }
  for (let b = 0; b < BUCKETS; b++) {
    if (!paths[b]) continue
    const hue = Math.round((1 - b / (BUCKETS - 1)) * 240)   // 240° blue → 0° red
    ctx.fillStyle = `hsl(${hue},100%,55%)`
    ctx.fill(paths[b])
  }
}

// Native image px → screen px.
function nativeToScreen(view, px, py) {
  return { x: (px / view.nw) * view.dispW + view.tx, y: (py / view.nh) * view.dispH + view.ty }
}

// ── Reprojection residuals ────────────────────────────────────────────────────

/** Amplification of the residual vectors, so sub-pixel misfits are visible. */
export const RESIDUAL_AMP = 25

/** Stroke colour of a residual vector by its raw magnitude (px). */
export function residualColor(mag) {
  return mag >= 2 ? '#e0533d' : (mag >= 1 ? '#e6a01e' : '#3fca77')
}

/**
 * Reprojection residual vectors (WS3): observation → (observation + AMP·residual).
 * A radial pattern = distortion misfit, a coherent translation = bad pose, random
 * speckle = fine. Colour by raw magnitude (green < 1px, amber < 2px, red ≥ 2px).
 * `residuals`: [{ px, py, du, dv, mag }] in native px.
 */
export function paintResiduals(ctx, view, residuals) {
  ctx.save()
  ctx.lineWidth = 1.2
  for (const r of residuals) {
    const a = nativeToScreen(view, r.px, r.py)
    const b = nativeToScreen(view, r.px + r.du * RESIDUAL_AMP, r.py + r.dv * RESIDUAL_AMP)
    ctx.strokeStyle = residualColor(r.mag)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.fillStyle = ctx.strokeStyle
    ctx.beginPath()
    ctx.arc(a.x, a.y, 1.4, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// ── Guided GCP marking ───────────────────────────────────────────────────────

// Small boxed caption at (x, y) — the guide equivalent of the marker labels,
// kept solid-line so the dashed guide stroke doesn't bleed into the text.
function drawGuideLabel(ctx, x, y, text, color) {
  ctx.save()
  ctx.setLineDash([])
  ctx.font = '11px sans-serif'
  const tw = ctx.measureText(text).width
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(x - 3, y - 7, tw + 6, 14)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}

/**
 * The label of a selected point guide. The mark count is the visible proof that
 * the prediction is N-view: it climbs as the user marks the GCP elsewhere, and the
 * cross-hair shifts with it. "7 of 9 marks" (rather than "9 marks, 2 ignored")
 * because a left-out mark is dropped from *this prediction only* — it stays in the
 * georeference fit and the accuracy report — and there is no room on a canvas
 * label to say so; a bare "ignored" would imply the GCP itself was discarded.
 * (A point guide always has ≥2 views — 1 would be an epipolar line.)
 */
export function pointGuideLabel(g) {
  const used = g.viewCount - (g.rejectedCount ?? 0)
  const marks = g.rejectedCount ? `${used} of ${g.viewCount} marks` : `${g.viewCount} marks`
  return `${g.name} — mark here (${marks})`
}

/**
 * Where the posed cameras say a not-yet-marked GCP must lie in this image, in a
 * distinct dashed green so a prediction is never mistaken for a placed mark:
 *   • point (≥2 other views) — ghost cross-hair at the predicted pixel;
 *   • line (1 other view) — the epipolar line the mark must sit on. Only for the
 *     selected GCP: every GCP's line at once is a spider web.
 * `guides` are core/sfm/gcpGuides.js guides in native px; `clipLine(line, w, h)`
 * clips a line to the frame (gcpGuides.js clipLineToRect).
 */
export function paintGcpGuides(ctx, view, guides, selectedGcpId, clipLine) {
  const { nw, nh } = view
  for (const g of guides) {
    const isSelected = g.gcpId != null && g.gcpId === selectedGcpId
    const strong = 'rgba(120,230,180,0.95)'
    const faint  = 'rgba(120,230,180,0.45)'
    ctx.save()
    ctx.setLineDash([5, 4])
    ctx.lineWidth = isSelected ? 1.8 : 1.2
    ctx.strokeStyle = isSelected ? strong : faint

    if (g.kind === 'line' && isSelected) {
      const seg = clipLine(g.line, nw, nh)
      if (seg) {
        const p0 = nativeToScreen(view, seg[0].x, seg[0].y)
        const p1 = nativeToScreen(view, seg[1].x, seg[1].y)
        ctx.beginPath()
        ctx.moveTo(p0.x, p0.y)
        ctx.lineTo(p1.x, p1.y)
        ctx.stroke()
        if (g.name) {
          drawGuideLabel(ctx, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2, `${g.name} — on this line`, strong)
        }
      }
    } else if (g.kind === 'point') {
      // A prediction outside the frame just means the GCP isn't visible here.
      if (g.u >= 0 && g.u <= nw && g.v >= 0 && g.v <= nh) {
        const { x, y } = nativeToScreen(view, g.u, g.v)
        ctx.beginPath()
        ctx.arc(x, y, 7, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(x - 11, y); ctx.lineTo(x - 3, y)
        ctx.moveTo(x + 3, y);  ctx.lineTo(x + 11, y)
        ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 3)
        ctx.moveTo(x, y + 3);  ctx.lineTo(x, y + 11)
        ctx.stroke()
        if (g.name && isSelected) drawGuideLabel(ctx, x + 12, y - 9, pointGuideLabel(g), strong)
      }
    }
    ctx.restore()
  }
}

// ── GCP markers ───────────────────────────────────────────────────────────────

/**
 * GCP observations on this image ([{ id, name, px, py, reprojPx? }], native px):
 * ring + cross-hair, and a label with the live reprojection error (red once > 5 px)
 * so a bad mark is obvious. The selected GCP is drawn in blue.
 */
export function paintGcps(ctx, view, gcps, selectedGcpId) {
  for (const g of gcps) {
    if (g.px == null || g.py == null) continue
    const { x, y } = nativeToScreen(view, g.px, g.py)
    const isSelected = g.id != null && g.id === selectedGcpId
    ctx.save()
    // Ring
    ctx.strokeStyle = isSelected ? 'rgba(80,200,255,0.95)' : 'rgba(255,210,0,0.95)'
    ctx.lineWidth = isSelected ? 2.5 : 1.5
    ctx.beginPath()
    ctx.arc(x, y, 7, 0, Math.PI * 2)
    ctx.stroke()
    // Cross-hair
    ctx.beginPath()
    ctx.moveTo(x - 11, y); ctx.lineTo(x - 3, y)
    ctx.moveTo(x + 3, y);  ctx.lineTo(x + 11, y)
    ctx.moveTo(x, y - 11);  ctx.lineTo(x, y - 3)
    ctx.moveTo(x, y + 3);   ctx.lineTo(x, y + 11)
    ctx.stroke()
    // Label — name, plus the live reprojection error (px) when available so a
    // bad mark is obvious. Colour the error red once it's clearly off (>5px).
    if (g.name) {
      const reproj = g.reprojPx != null ? `  ${g.reprojPx.toFixed(1)}px` : ''
      const label = g.name + reproj
      ctx.font = '11px sans-serif'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(x + 9, y - 16, tw + 6, 14)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = isSelected ? 'rgba(80,200,255,0.95)' : 'rgba(255,210,0,0.95)'
      ctx.fillText(g.name, x + 12, y - 9)
      if (reproj) {
        const nameW = ctx.measureText(g.name).width
        ctx.fillStyle = g.reprojPx > 5 ? 'rgba(255,90,90,0.95)' : 'rgba(160,230,160,0.95)'
        ctx.fillText(reproj, x + 12 + nameW, y - 9)
      }
    }
    ctx.restore()
  }
}

// ── Fiducial marks (F4) ───────────────────────────────────────────────────────

/**
 * Fiducial observations ([{ fidId, px, py }], native px) — distinct from GCPs:
 * magenta squares with a diagonal cross, labelled with the per-mark fit residual
 * (`residualUm`: fidId → µm, once ≥3 marks give a fit; red past ~½ a 23 µm pixel).
 * Then the ghost guides ([{ id, px, py }]): faint dashed squares where each
 * not-yet-placed mark should land, so the user can aim at the remaining ones.
 */
export function paintFiducials(ctx, view, obs, residualUm, ghosts) {
  for (const o of obs) {
    if (o.px == null || o.py == null) continue
    const { x, y } = nativeToScreen(view, o.px, o.py)
    ctx.save()
    ctx.strokeStyle = 'rgba(255,80,220,0.95)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x - 6, y - 6, 12, 12)
    ctx.beginPath()
    ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6)
    ctx.moveTo(x - 6, y + 6); ctx.lineTo(x + 6, y - 6)
    ctx.stroke()
    const res = residualUm.get(o.fidId)
    const label = o.fidId + (res != null ? `  ${res.toFixed(1)}µm` : '')
    ctx.font = '11px sans-serif'
    const tw = ctx.measureText(label).width
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(x + 9, y - 16, tw + 6, 14)
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255,120,230,0.95)'
    ctx.fillText(o.fidId, x + 12, y - 9)
    if (res != null) {
      const nameW = ctx.measureText(o.fidId).width
      // Warn (red) once residual exceeds ~½ a 23µm pixel — scanner-noise scale.
      ctx.fillStyle = res > 12 ? 'rgba(255,90,90,0.95)' : 'rgba(160,230,160,0.95)'
      ctx.fillText(`  ${res.toFixed(1)}µm`, x + 12 + nameW, y - 9)
    }
    ctx.restore()
  }

  for (const g of ghosts) {
    const { x, y } = nativeToScreen(view, g.px, g.py)
    ctx.save()
    ctx.strokeStyle = 'rgba(255,80,220,0.5)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.strokeRect(x - 6, y - 6, 12, 12)
    ctx.setLineDash([])
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255,120,230,0.55)'
    ctx.fillText(g.id, x + 10, y)
    ctx.restore()
  }
}

// ── Magnifier loupe ───────────────────────────────────────────────────────────

/**
 * Magnified inset of the image around the cursor (`mouse`, viewport px), pinned to
 * the top-right corner so it never covers the point being marked. Sampled straight
 * from the bitmap `img` so it's crisp regardless of the current zoom; a centre
 * crosshair marks the exact pixel. ZOOM is screen px per native px; the source rect
 * converts native → bitmap px through `frame.bitmapScale`. Nothing is drawn for an
 * inexact frame (a preview of unknown native size) or a cursor off the image.
 */
export function paintLoupe(ctx, view, img, frame, mouse) {
  if (!img || !frame?.exact) return
  const ipx = (mouse.x - view.tx) / view.scale
  const ipy = (mouse.y - view.ty) / view.scale
  if (ipx < 0 || ipy < 0 || ipx >= frame.width || ipy >= frame.height) return

  const SIZE = 128, ZOOM = 8, src = (SIZE / ZOOM) * frame.bitmapScale
  const bx = ipx * frame.bitmapScale, by = ipy * frame.bitmapScale
  const lx = view.w - SIZE - 12, ly = 12

  ctx.save()
  ctx.beginPath(); ctx.rect(lx, ly, SIZE, SIZE); ctx.clip()
  ctx.fillStyle = '#000'; ctx.fillRect(lx, ly, SIZE, SIZE)
  ctx.imageSmoothingEnabled = false
  try {
    ctx.drawImage(img, bx - src / 2, by - src / 2, src, src, lx, ly, SIZE, SIZE)
  } catch { /* source rect off-image near the edge — skip */ }
  // Centre crosshair (the pixel that a mark would land on).
  const cx = lx + SIZE / 2, cy = ly + SIZE / 2
  ctx.strokeStyle = 'rgba(255,210,0,0.95)'; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy)
  ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8)
  ctx.stroke()
  ctx.restore()
  // Border.
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1
  ctx.strokeRect(lx + 0.5, ly + 0.5, SIZE, SIZE)
}

// ── Mask-edit cursors ─────────────────────────────────────────────────────────

/** Brush/eraser cursor: a circle of the brush's screen radius at `mouse`. */
export function paintBrushCursor(ctx, mouse, radius, erase) {
  ctx.beginPath()
  ctx.arc(mouse.x, mouse.y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = erase ? 'rgba(100,180,255,0.9)' : 'rgba(255,80,80,0.9)'
  ctx.lineWidth = 1.5
  ctx.stroke()
}

/**
 * In-flight rectangle preview (dashed; blue while Alt = erase). `rect` is
 * { x0, y0, x1, y1, erase } with corners in native px, in any order.
 */
export function paintRectPreview(ctx, view, rect) {
  const rx = Math.min(rect.x0, rect.x1) * view.scale + view.tx
  const ry = Math.min(rect.y0, rect.y1) * view.scale + view.ty
  const rw = Math.abs(rect.x1 - rect.x0) * view.scale
  const rh = Math.abs(rect.y1 - rect.y0) * view.scale
  ctx.save()
  ctx.setLineDash([5, 4])
  ctx.strokeStyle = rect.erase ? 'rgba(100,180,255,0.9)' : 'rgba(255,80,80,0.9)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(rx, ry, rw, rh)
  ctx.restore()
}
