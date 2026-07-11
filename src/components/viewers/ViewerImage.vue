<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { maskFromSource, invertMaskPixels, anyExcluded } from '../../core/mask.js'
import { depthColor } from '../../core/products/colormap.js'
import { fitFiducialAffine, mmToScan } from '../../core/sfm/fiducials.js'
import MaskToolbar from './MaskToolbar.vue'

const props = defineProps({
  image:         { type: Object,  required: true },
  showKeypoints: { type: Boolean, default: false },
  showMask:      { type: Boolean, default: false },
  showDepth:     { type: Boolean, default: false },
  showGcps:      { type: Boolean, default: false },
  gcps:          { type: Array,   default: () => [] }, // [{ id, name, px, py, reprojPx? }] observations on this image
  allGcps:       { type: Array,   default: () => [] }, // [{ id, name }] every GCP, for the right-click "assign" menu
  selectedGcpId: { type: String,  default: null },
  maskEdit:      { type: Boolean, default: false }, // mask-edit mode (floating toolbar)
  // Film sensor (F4): the sensor's calibrated fiducial marks + this image's
  // clicked observations. isFilm gates the "Mark fiducial…" menu + overlay.
  isFilm:        { type: Boolean, default: false },
  showFiducials: { type: Boolean, default: false }, // overlay toggle for fiducial marks
  fiducialMarks: { type: Array,   default: () => [] }, // [{ id, xMm, yMm }]
  fiducialObs:   { type: Array,   default: () => [] }, // [{ fidId, px, py }]
})

// mark-gcp: assign this pixel to an existing GCP { gcpId, px, py }.
// add-gcp:  create a new GCP marked at this pixel { px, py }.
// mark-fiducial: assign this pixel to a fiducial mark { fidId, px, py }.
// exit-mask-edit: user closed the mask toolbar (×) — parent owns the maskEdit flag.
const emit = defineEmits(['update-mask', 'update-depth', 'mark-gcp', 'add-gcp', 'mark-fiducial', 'exit-mask-edit'])

// Live fiducial fit (F4): join this image's observations with the sensor's
// calibrated marks and fit the scan→mm affine once ≥3 land, so per-mark residual
// (µm) can be shown next to each marker — the same live feedback as GCP reproj.
const fidFit = computed(() => {
  if (!props.isFilm || !props.fiducialObs?.length) return { obs: [], fit: null }
  const byId = new Map(props.fiducialMarks.map((m) => [m.id, m]))
  const obs = props.fiducialObs
    .map((o) => {
      const m = byId.get(o.fidId)
      return m ? { fidId: o.fidId, px: o.px, py: o.py, xMm: m.xMm, yMm: m.yMm } : null
    })
    .filter(Boolean)
  return { obs, fit: obs.length >= 3 ? fitFiducialAffine(obs) : null }
})
// fidId → residual µm (aligned with fidFit.obs order).
const fidResidual = computed(() => {
  const { obs, fit } = fidFit.value
  const m = new Map()
  if (fit) obs.forEach((o, i) => m.set(o.fidId, fit.residualsUm[i]))
  return m
})
// Which mark ids are already placed on this image (for the menu ✓).
const markedFidIds = computed(() => new Set(props.fiducialObs.map((o) => o.fidId)))

// Rough position label per mark ("top-left", "mid-top", "center"…) derived from
// its calibrated mm coordinates relative to the layout centroid. A guide only —
// tells the user which physical corner/edge a mark id refers to. mm frame is
// camera-standard (x right, y up), so larger yMm ⇒ top.
const fidMarkPos = computed(() => {
  const marks = props.fiducialMarks.filter((m) => Number.isFinite(m.xMm) && Number.isFinite(m.yMm))
  const out = new Map()
  if (!marks.length) return out
  let cx = 0, cy = 0, ext = 0
  for (const m of marks) { cx += m.xMm; cy += m.yMm }
  cx /= marks.length; cy /= marks.length
  for (const m of marks) ext = Math.max(ext, Math.abs(m.xMm - cx), Math.abs(m.yMm - cy))
  const tol = 0.15 * (ext || 1)
  for (const m of marks) {
    const dx = m.xMm - cx, dy = m.yMm - cy
    const v = dy > tol ? 'top' : dy < -tol ? 'bottom' : ''
    const h = dx > tol ? 'right' : dx < -tol ? 'left' : ''
    const label = [v, h].filter(Boolean).join('-') || 'center'
    out.set(m.id, v && h ? label : (v || h ? `mid-${label}` : 'center'))
  }
  return out
})

// Ghost guides: once a fit exists (≥3 marks placed), predict where each
// not-yet-placed mark should land on the raster (mm → scan px), so the user can
// aim at the remaining fiducials. [{ id, px, py }] in native image pixels.
const fidGhosts = computed(() => {
  const { fit } = fidFit.value
  if (!fit) return []
  const placed = markedFidIds.value
  const out = []
  for (const m of props.fiducialMarks) {
    if (placed.has(m.id) || !Number.isFinite(m.xMm) || !Number.isFinite(m.yMm)) continue
    const p = mmToScan(m.xMm, m.yMm, fit.A)
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push({ id: m.id, px: p.x, py: p.y })
  }
  return out
})

const container      = ref(null)
const imgEl          = ref(null)
const overlayCanvas  = ref(null)
const maskFileInput  = ref(null)
const depthFileInput = ref(null)

// Pan/zoom
const scale    = ref(1)
const tx       = ref(0)
const ty       = ref(0)
const dragging = ref(false)
const hoverPx  = ref(null)

// True once the current image has loaded AND been fitted to the viewport —
// gates the <img> visibility so the browser never paints it at native
// (potentially huge) size for a frame before fit() scales it down.
const imageReady = ref(false)

// Mask canvas state
const hasMask = ref(!!props.image.mask)

// Mask-edit tool state (local: the floating toolbar and this viewer are the
// only consumers; per-tab persistence comes free from v-show-kept instances).
const tool        = ref(null)   // 'brush' | 'erase' | 'rect' | null (pan while editing)
const brushRadius = ref(20)     // screen pixels — constant on screen, ÷scale in image space
const maskOpacity = ref(0.45)   // red-overlay alpha while editing/viewing
// Undo/redo as stacks of persisted mask dataUrls (null = no mask). Snapshots are
// the *previous* store value taken just before each committed change, so memory
// cost is a handful of compressed PNG strings, not raw pixel buffers.
const undoStack = ref([])
const redoStack = ref([])
const UNDO_MAX = 10

let rectDrag = null // { x0, y0, x1, y1, erase } image-px corners of an in-flight rectangle

let maskOffscreen  = null  // OffscreenCanvas at native image resolution
let depthOffscreen = null  // OffscreenCanvas holding colorized depth at native resolution
const hasDepth = ref(!!props.image.depth)
let mousePos      = null  // { x, y } screen coords for brush cursor
let isDrawing     = false
let strokeHit     = false // did the in-flight brush/erase stroke touch the image?
let startX = 0, startY = 0, startTx = 0, startTy = 0
let resizeObserver = null
let offscreenCtx   = null

const MIN_SCALE = 0.05
const MAX_SCALE = 40

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

// ── Fit & zoom ───────────────────────────────────────────────────────────────

function fit() {
  const c   = container.value
  const img = imgEl.value
  if (!c || !img || !img.naturalWidth) return
  const s = Math.min(c.clientWidth / img.naturalWidth, c.clientHeight / img.naturalHeight, 1)
  scale.value = s
  tx.value = (c.clientWidth  - img.naturalWidth  * s) / 2
  ty.value = (c.clientHeight - img.naturalHeight * s) / 2
  drawOverlay()
}

// Zoom by `factor` keeping the viewport point (cx, cy) fixed on screen.
function zoomAt(factor, cx, cy) {
  const newScale = clamp(scale.value * factor, MIN_SCALE, MAX_SCALE)
  const ratio = newScale / scale.value
  tx.value = cx - (cx - tx.value) * ratio
  ty.value = cy - (cy - ty.value) * ratio
  scale.value = newScale
  drawOverlay()
}

function applyZoom(factor) {
  const c = container.value
  if (!c) return
  zoomAt(factor, c.clientWidth / 2, c.clientHeight / 2)
}

function zoomIn()  { applyZoom(1.5) }
function zoomOut() { applyZoom(1 / 1.5) }

// ── Overlay canvas (mask + keypoints + brush cursor) ─────────────────────────

// Legend colour ramps as [offset, cssColor] stops.
const KEYPOINT_STOPS = [
  [0,   'hsl(240,100%,55%)'],
  [0.5, 'hsl(120,100%,55%)'],
  [1,   'hsl(0,100%,55%)'],
]
// Sample the depth ramp (core/colormap depthColor) at a few points for the gradient.
const DEPTH_STOPS = [0, 0.25, 0.5, 0.75, 1].map((t) => {
  const [r, g, b] = depthColor(t)
  return [t, `rgb(${r},${g},${b})`]
})

// Draw a labelled colour-ramp legend stacked up from the bottom-left corner.
// `slot` (0-based) offsets successive legends vertically so they don't overlap.
function drawLegend(ctx, h, slot, stops, leftLabel, rightLabel, title) {
  const LW = 72, LH = 8, ROW = 34
  const LX = 12
  const LY = h - 36 - slot * ROW
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
  ctx.fillText(leftLabel, LX, LY + LH + 10)
  ctx.textAlign = 'right'
  ctx.fillText(rightLabel, LX + LW, LY + LH + 10)
  ctx.textAlign = 'center'
  ctx.fillText(title, LX + LW / 2, LY - 3)
  ctx.restore()
}

function drawOverlay() {
  const c   = overlayCanvas.value
  const img = imgEl.value
  if (!c || !img || !img.naturalWidth || !container.value) return

  const w = container.value.clientWidth
  const h = container.value.clientHeight
  if (!w || !h) return

  const dpr = window.devicePixelRatio || 1
  const pw  = Math.round(w * dpr)
  const ph  = Math.round(h * dpr)
  if (c.width !== pw || c.height !== ph) {
    c.width  = pw
    c.height = ph
    c.style.width  = `${w}px`
    c.style.height = `${h}px`
  }

  const ctx = c.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const dispW = img.naturalWidth  * scale.value
  const dispH = img.naturalHeight * scale.value

  // Colour legends stack up from the bottom-left corner (one row per active overlay).
  let legendSlot = 0

  // Depth — colorized semi-transparent overlay at image position
  if (depthOffscreen && hasDepth.value && props.showDepth) {
    ctx.save()
    ctx.globalAlpha = 0.6
    ctx.drawImage(depthOffscreen, tx.value, ty.value, dispW, dispH)
    ctx.restore()
    drawLegend(ctx, h, legendSlot++, DEPTH_STOPS, 'near', 'far', 'depth')
  }

  // Mask — red semi-transparent overlay at image position
  if (maskOffscreen && hasMask.value && props.showMask) {
    ctx.save()
    ctx.globalAlpha = maskOpacity.value
    ctx.drawImage(maskOffscreen, tx.value, ty.value, dispW, dispH)
    ctx.restore()
  }

  // Keypoints — colour-coded dots (cold=blue → hot=red by SIFT response)
  if (props.showKeypoints && props.image.keypoints?.length) {
    const kps = props.image.keypoints
    let minR = Infinity, maxR = -Infinity
    for (const kp of kps) {
      if (kp.response < minR) minR = kp.response
      if (kp.response > maxR) maxR = kp.response
    }
    const range = maxR - minR || 1
    for (const kp of kps) {
      const x = kp.nx * dispW + tx.value
      const y = kp.ny * dispH + ty.value
      const t = (kp.response - minR) / range      // 0 = coldest, 1 = hottest
      const hue = Math.round((1 - t) * 240)       // 240° blue → 0° red
      ctx.fillStyle = `hsl(${hue},100%,55%)`
      ctx.beginPath()
      ctx.arc(x, y, 2, 0, Math.PI * 2)
      ctx.fill()
    }

    drawLegend(ctx, h, legendSlot++, KEYPOINT_STOPS, 'low', 'high', 'response')
  }

  // GCP markers — observation pixel positions on this image
  if (props.showGcps && props.gcps?.length && img.naturalWidth) {
    for (const g of props.gcps) {
      if (g.px == null || g.py == null) continue
      const x = (g.px / img.naturalWidth)  * dispW + tx.value
      const y = (g.py / img.naturalHeight) * dispH + ty.value
      const isSelected = g.id != null && g.id === props.selectedGcpId
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

  // Fiducial markers (F4) — distinct from GCPs: magenta squares with a diagonal
  // cross. Show the per-mark fit residual (µm) once ≥3 marks give a fit.
  if (props.showFiducials && props.isFilm && props.fiducialObs?.length && img.naturalWidth) {
    for (const o of props.fiducialObs) {
      if (o.px == null || o.py == null) continue
      const x = (o.px / img.naturalWidth)  * dispW + tx.value
      const y = (o.py / img.naturalHeight) * dispH + ty.value
      ctx.save()
      ctx.strokeStyle = 'rgba(255,80,220,0.95)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(x - 6, y - 6, 12, 12)
      ctx.beginPath()
      ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6)
      ctx.moveTo(x - 6, y + 6); ctx.lineTo(x + 6, y - 6)
      ctx.stroke()
      const res = fidResidual.value.get(o.fidId)
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

    // Ghost guides — faint dashed squares at the predicted location of each
    // not-yet-placed mark, so the user can aim at the remaining fiducials.
    for (const g of fidGhosts.value) {
      const x = (g.px / img.naturalWidth)  * dispW + tx.value
      const y = (g.py / img.naturalHeight) * dispH + ty.value
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

  // Magnifier loupe — a zoomed inset around the cursor while working with GCPs,
  // so marks can be placed precisely without zooming the whole view. Drawn last
  // (on top), pinned to a corner so it never covers the point being marked.
  if ((props.showGcps || (props.showFiducials && props.isFilm)) && mousePos) {
    drawLoupe(ctx, w, h)
  }

  // Brush cursor circle (brush/eraser tools)
  if (props.maskEdit && (tool.value === 'brush' || tool.value === 'erase') && mousePos) {
    ctx.beginPath()
    ctx.arc(mousePos.x, mousePos.y, brushRadius.value, 0, Math.PI * 2)
    ctx.strokeStyle = tool.value === 'brush' ? 'rgba(255,80,80,0.9)' : 'rgba(100,180,255,0.9)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // In-flight rectangle preview (dashed; blue while Alt = erase)
  if (rectDrag) {
    const rx = Math.min(rectDrag.x0, rectDrag.x1) * scale.value + tx.value
    const ry = Math.min(rectDrag.y0, rectDrag.y1) * scale.value + ty.value
    const rw = Math.abs(rectDrag.x1 - rectDrag.x0) * scale.value
    const rh = Math.abs(rectDrag.y1 - rectDrag.y0) * scale.value
    ctx.save()
    ctx.setLineDash([5, 4])
    ctx.strokeStyle = rectDrag.erase ? 'rgba(100,180,255,0.9)' : 'rgba(255,80,80,0.9)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.restore()
  }
}

// Magnified inset of the image around the cursor's pixel, pinned to the top-right
// corner. Sampled straight from the <img> element (natural resolution) so it's
// crisp regardless of the current zoom. A centre crosshair marks the exact pixel.
function drawLoupe(ctx, w) {
  const img = imgEl.value
  if (!img?.naturalWidth) return
  const ipx = (mousePos.x - tx.value) / scale.value
  const ipy = (mousePos.y - ty.value) / scale.value
  if (ipx < 0 || ipy < 0 || ipx >= img.naturalWidth || ipy >= img.naturalHeight) return

  const SIZE = 128, ZOOM = 8, src = SIZE / ZOOM
  const lx = w - SIZE - 12, ly = 12

  ctx.save()
  ctx.beginPath(); ctx.rect(lx, ly, SIZE, SIZE); ctx.clip()
  ctx.fillStyle = '#000'; ctx.fillRect(lx, ly, SIZE, SIZE)
  ctx.imageSmoothingEnabled = false
  try {
    ctx.drawImage(img, ipx - src / 2, ipy - src / 2, src, src, lx, ly, SIZE, SIZE)
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

// ── Mask operations ───────────────────────────────────────────────────────────

function initMaskCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  maskOffscreen = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
  if (props.image.mask?.dataUrl) loadMaskFromDataUrl(props.image.mask.dataUrl)
}

async function loadMaskFromDataUrl(dataUrl) {
  if (!maskOffscreen) return
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bmp  = await createImageBitmap(blob)
    const ctx  = maskOffscreen.getContext('2d')
    ctx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
    ctx.drawImage(bmp, 0, 0, maskOffscreen.width, maskOffscreen.height)
    hasMask.value = true
    drawOverlay()
  } catch {}
}

// Does a brush circle (image coords, radius r) overlap the image rectangle at
// all? The mask canvas is exactly image-sized, so a stroke fully outside paints
// zero pixels — without this test it would still flip hasMask + save an empty
// mask. Uses the closest point on [0,w]×[0,h] to the circle centre.
function circleIntersectsImage(cx, cy, r) {
  const img = imgEl.value
  if (!img?.naturalWidth) return false
  const dx = cx - clamp(cx, 0, img.naturalWidth)
  const dy = cy - clamp(cy, 0, img.naturalHeight)
  return dx * dx + dy * dy <= r * r
}

// Paint or erase a circle at screen position onto the mask canvas. Brush radius
// stays constant in screen space (divided by scale → image coords). Returns
// whether the stroke actually touched the image (so a fully-outside stroke can
// be discarded rather than committed as an empty mask).
function paintAt(sx, sy) {
  if (!maskOffscreen) return false
  const imgX = (sx - tx.value) / scale.value
  const imgY = (sy - ty.value) / scale.value
  const r    = brushRadius.value / scale.value
  if (!circleIntersectsImage(imgX, imgY, r)) return false
  const ctx  = maskOffscreen.getContext('2d')

  if (tool.value === 'brush') {
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'red'
    ctx.beginPath()
    ctx.arc(imgX, imgY, r, 0, Math.PI * 2)
    ctx.fill()
    hasMask.value = true
  } else if (tool.value === 'erase') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(imgX, imgY, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
  return true
}

// ── Undo / redo ────────────────────────────────────────────────────────────────
// Push the *current persisted* mask (still the pre-change value — commits happen
// after the snapshot) onto the undo stack. Every committed change (stroke end,
// rectangle, invert, import, clear) snapshots first, so undo restores exactly
// the states the store has seen.
function snapshotForUndo() {
  undoStack.value.push(props.image.mask?.dataUrl ?? null)
  if (undoStack.value.length > UNDO_MAX) undoStack.value.shift()
  redoStack.value = []
}

const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)

// Restore a snapshot onto the canvas and re-emit it as the persisted mask.
function applyMaskUrl(url) {
  if (url) {
    loadMaskFromDataUrl(url)
  } else if (maskOffscreen) {
    maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
    hasMask.value = false
    drawOverlay()
  }
  emit('update-mask', url)
}

function undoMask() {
  if (!undoStack.value.length) return
  redoStack.value.push(props.image.mask?.dataUrl ?? null)
  applyMaskUrl(undoStack.value.pop())
}

function redoMask() {
  if (!redoStack.value.length) return
  undoStack.value.push(props.image.mask?.dataUrl ?? null)
  applyMaskUrl(redoStack.value.pop())
}

// ── Rectangle & invert ─────────────────────────────────────────────────────────

async function commitRect() {
  if (!rectDrag || !maskOffscreen) { rectDrag = null; return }
  const { x0, y0, x1, y1, erase } = rectDrag
  rectDrag = null
  const x = Math.min(x0, x1), y = Math.min(y0, y1)
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0)
  if (w < 1 || h < 1) { drawOverlay(); return }
  snapshotForUndo()
  const ctx = maskOffscreen.getContext('2d')
  if (erase) {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillRect(x, y, w, h)
    ctx.globalCompositeOperation = 'source-over'
  } else {
    ctx.fillStyle = 'red'
    ctx.fillRect(x, y, w, h)
    hasMask.value = true
  }
  drawOverlay()
  await exportMask(erase) // an erase-rectangle can empty the mask
}

// Swap excluded ↔ kept over the whole canvas. An inversion that leaves nothing
// excluded commits `null` (no mask) rather than an all-transparent PNG.
async function invertMask() {
  if (!maskOffscreen) return
  const ctx = maskOffscreen.getContext('2d')
  const id  = ctx.getImageData(0, 0, maskOffscreen.width, maskOffscreen.height)
  const excluded = invertMaskPixels(id.data)
  ctx.putImageData(id, 0, 0)
  snapshotForUndo()
  hasMask.value = excluded > 0
  drawOverlay()
  if (excluded > 0) await exportMask()
  else emit('update-mask', null)
}

// True when the mask canvas has no excluded pixels left (e.g. after erasing the
// last of a mask). Reads the whole canvas, so only call on commits that can
// empty it (erase/rect-erase/import) — a draw is trivially non-empty.
function maskCanvasEmpty() {
  if (!maskOffscreen) return true
  const ctx = maskOffscreen.getContext('2d')
  const id  = ctx.getImageData(0, 0, maskOffscreen.width, maskOffscreen.height)
  return !anyExcluded(id.data)
}

// Persist the current mask canvas. With `checkEmpty` (erase-type commits), first
// tests whether anything is still masked and commits `null` (no mask) if not —
// so erasing the last pixels clears the mask instead of saving an empty PNG.
async function exportMask(checkEmpty = false) {
  if (!maskOffscreen) return
  if (checkEmpty && maskCanvasEmpty()) {
    hasMask.value = false
    emit('update-mask', null)
    return
  }
  const blob   = await maskOffscreen.convertToBlob({ type: 'image/png' })
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
  hasMask.value = true
  emit('update-mask', dataUrl)
}

// Clear is undoable (snapshot first) — no confirm dialog needed anymore.
function clearMask() {
  if (!maskOffscreen || !hasMask.value) return
  snapshotForUndo()
  maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
  hasMask.value = false
  emit('update-mask', null)
  drawOverlay()
}

function triggerMaskImport() {
  maskFileInput.value?.click()
}

// Import an image as mask: bright/opaque pixels → red (masked region). Shared
// normalize/rescale logic lives in core/mask.js (also used by the Mask Manager).
async function onMaskFileChange(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !maskOffscreen) return
  try {
    const dataUrl = await maskFromSource(file, maskOffscreen.width, maskOffscreen.height)
    snapshotForUndo()
    await loadMaskFromDataUrl(dataUrl)
    await exportMask(true) // a blank imported image shouldn't register as a mask
  } catch (err) {
    console.error('Failed to import mask:', err)
  }
}

// ── Depth map operations ──────────────────────────────────────────────────────

function initDepthCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  depthOffscreen = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
  if (props.image.depth?.dataUrl) loadDepthFromDataUrl(props.image.depth.dataUrl)
}

// Already-colorized depth maps are stored as PNG data URLs; just blit them in.
async function loadDepthFromDataUrl(dataUrl) {
  if (!depthOffscreen) return
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bmp  = await createImageBitmap(blob)
    const ctx  = depthOffscreen.getContext('2d')
    ctx.clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
    ctx.drawImage(bmp, 0, 0, depthOffscreen.width, depthOffscreen.height)
    hasDepth.value = true
    drawOverlay()
  } catch {}
}


function triggerDepthImport() {
  depthFileInput.value?.click()
}

// Import a (typically grayscale) depth image, normalize by luminance, and
// store a colorized version. Fully transparent / zero pixels are treated as "no data".
async function onDepthFileChange(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !depthOffscreen) return
  try {
    const bmp    = await createImageBitmap(file)
    const tmp    = new OffscreenCanvas(depthOffscreen.width, depthOffscreen.height)
    const tmpCtx = tmp.getContext('2d')
    tmpCtx.drawImage(bmp, 0, 0, tmp.width, tmp.height)
    const id = tmpCtx.getImageData(0, 0, tmp.width, tmp.height)
    const d  = id.data

    // Find min/max luminance over valid pixels for contrast normalization.
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
      if (lum < lo) lo = lum
      if (lum > hi) hi = lum
    }
    const range = hi - lo || 1

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) { d[i + 3] = 0; continue }
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
      const t = (lum - lo) / range
      const [r, g, b] = depthColor(t)
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
    }
    const ctx = depthOffscreen.getContext('2d')
    ctx.clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
    ctx.putImageData(id, 0, 0)
    hasDepth.value = true
    await exportDepth()
    drawOverlay()
  } catch (err) {
    console.error('Failed to import depth map:', err)
  }
}

async function exportDepth() {
  if (!depthOffscreen) return
  const blob = await depthOffscreen.convertToBlob({ type: 'image/png' })
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
  emit('update-depth', dataUrl)
}

function clearDepth() {
  if (!depthOffscreen) return
  depthOffscreen.getContext('2d').clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
  hasDepth.value = false
  emit('update-depth', null)
  drawOverlay()
}

// ── Mouse handlers ────────────────────────────────────────────────────────────

function getViewportCoords(e) {
  const rect = container.value.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

// Convert viewport coords to native image pixel coords (clamped to the image).
function toImagePixel(sx, sy) {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return null
  return {
    px: clamp((sx - tx.value) / scale.value, 0, img.naturalWidth),
    py: clamp((sy - ty.value) / scale.value, 0, img.naturalHeight),
  }
}

// ── Right-click context menu ──────────────────────────────────────────────────
// Two-stage: a general 'main' menu whose "Add GCP here…" entry switches the same
// popup to 'gcp' mode (new-vs-existing chooser at the same anchor).
// { x, y (viewport, for positioning), px, py (image pixel), mode } or null.
const menu = ref(null)

function onContextMenu(e) {
  if (props.maskEdit && tool.value) return // don't hijack right-click while a mask tool is active
  e.preventDefault()
  const { x, y } = getViewportCoords(e)
  const pix = toImagePixel(x, y)
  if (!pix) return
  const cw = container.value?.clientWidth ?? 0
  const ch = container.value?.clientHeight ?? 0
  menu.value = {
    x: Math.min(x, Math.max(0, cw - 200)),
    y: Math.min(y, Math.max(0, ch - 240)),
    px: pix.px, py: pix.py, mode: 'main',
  }
}

function closeMenu() { menu.value = null }
function menuBack()  { if (menu.value) menu.value = { ...menu.value, mode: 'main' } }

// "Add GCP here…" → switch the popup to the new-vs-existing chooser.
function menuAddGcp() { if (menu.value) menu.value = { ...menu.value, mode: 'gcp' } }
function menuNewGcp() {
  if (menu.value) emit('add-gcp', { px: menu.value.px, py: menu.value.py })
  closeMenu()
}
function menuAssign(gcpId) {
  if (menu.value) emit('mark-gcp', { gcpId, px: menu.value.px, py: menu.value.py })
  closeMenu()
}

// "Mark fiducial…" (film sensors) → the mark chooser sub-menu.
function menuAddFiducial() { if (menu.value) menu.value = { ...menu.value, mode: 'fiducial' } }
function menuMarkFiducial(fidId) {
  if (menu.value) emit('mark-fiducial', { fidId, px: menu.value.px, py: menu.value.py })
  closeMenu()
}

async function menuCopyCoords() {
  if (menu.value) {
    try { await navigator.clipboard.writeText(`${Math.round(menu.value.px)}, ${Math.round(menu.value.py)}`) } catch { /* clipboard blocked */ }
  }
  closeMenu()
}
async function menuCopyColor() {
  if (menu.value && offscreenCtx) {
    const px = Math.floor(menu.value.px), py = Math.floor(menu.value.py)
    const d = offscreenCtx.getImageData(px, py, 1, 1).data
    try { await navigator.clipboard.writeText(`rgb(${d[0]}, ${d[1]}, ${d[2]})`) } catch { /* clipboard blocked */ }
  }
  closeMenu()
}
function menuZoomIn() { if (menu.value) zoomAt(1.8, menu.value.x, menu.value.y); closeMenu() }
function menuFit()    { fit(); closeMenu() }

function onMouseDown(e) {
  if (menu.value && e.button === 0) { closeMenu(); return }
  const activeTool = props.maskEdit ? tool.value : null
  if (activeTool === 'rect' && e.button === 0) {
    const { x, y } = getViewportCoords(e)
    const pix = toImagePixel(x, y)
    if (pix) rectDrag = { x0: pix.px, y0: pix.py, x1: pix.px, y1: pix.py, erase: e.altKey }
    drawOverlay()
  } else if ((activeTool === 'brush' || activeTool === 'erase') && e.button === 0) {
    isDrawing = true
    strokeHit = false
    const { x, y } = getViewportCoords(e)
    strokeHit = paintAt(x, y) || strokeHit
    drawOverlay()
  } else if (e.button === 0) {
    dragging.value = true
    startX  = e.clientX
    startY  = e.clientY
    startTx = tx.value
    startTy = ty.value
  }
}

function onMouseMove(e) {
  const { x, y } = getViewportCoords(e)
  mousePos = { x, y }

  if (rectDrag) {
    const pix = toImagePixel(x, y)
    if (pix) { rectDrag.x1 = pix.px; rectDrag.y1 = pix.py; rectDrag.erase = e.altKey }
  } else if (isDrawing && tool.value) {
    strokeHit = paintAt(x, y) || strokeHit
  } else if (dragging.value) {
    tx.value = startTx + (e.clientX - startX)
    ty.value = startTy + (e.clientY - startY)
  }

  // Pixel color for status bar
  const px  = Math.floor((x - tx.value) / scale.value)
  const py  = Math.floor((y - ty.value) / scale.value)
  const img = imgEl.value
  if (img && px >= 0 && py >= 0 && px < img.naturalWidth && py < img.naturalHeight) {
    const info = { x: px, y: py, r: null, g: null, b: null, masked: null }
    if (offscreenCtx) {
      const pixel = offscreenCtx.getImageData(px, py, 1, 1).data
      info.r = pixel[0]; info.g = pixel[1]; info.b = pixel[2]
    }
    // Whether this pixel is excluded by the mask (opaque on the mask canvas).
    if (maskOffscreen && hasMask.value) {
      info.masked = maskOffscreen.getContext('2d').getImageData(px, py, 1, 1).data[3] > 127
    }
    hoverPx.value = info
  } else {
    hoverPx.value = null
  }

  drawOverlay()
}

async function onMouseUp() {
  if (rectDrag) { await commitRect(); return }
  if (isDrawing) {
    isDrawing = false
    // A stroke that never touched the image is a no-op — don't save an empty mask.
    // An erase can empty the mask, so re-check on that path.
    if (strokeHit) { snapshotForUndo(); await exportMask(tool.value === 'erase') }
  }
  dragging.value = false
}

function onMouseLeave() {
  dragging.value = false
  rectDrag = null // cancel an in-flight rectangle rather than guessing its corner
  if (isDrawing) { isDrawing = false; if (strokeHit) { snapshotForUndo(); exportMask(tool.value === 'erase') } }
  mousePos      = null
  hoverPx.value = null
  drawOverlay()
}

function onWheel(e) {
  e.preventDefault()
  closeMenu() // its anchor pixel would drift under the zoom
  const rect     = container.value.getBoundingClientRect()
  const cx       = e.clientX - rect.left
  const cy       = e.clientY - rect.top
  const factor   = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const newScale = clamp(scale.value * factor, MIN_SCALE, MAX_SCALE)
  const ratio    = newScale / scale.value
  tx.value    = cx - (cx - tx.value) * ratio
  ty.value    = cy - (cy - ty.value) * ratio
  scale.value = newScale
  drawOverlay()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function setupOffscreenCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  try {
    const c    = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    offscreenCtx = c.getContext('2d')
    offscreenCtx.drawImage(img, 0, 0)
  } catch {
    offscreenCtx = null
  }
}

function onImgLoad() {
  fit()
  setupOffscreenCanvas()
  initMaskCanvas()
  initDepthCanvas()
  imageReady.value = true
}

// A new `url` means a new decode (image switch, or the TIFF thumbnail →
// full-res swap) — hide the old frame until the new one has loaded and been
// fitted, instead of flashing native size or a stale image.
watch(() => props.image.url, () => { imageReady.value = false })

// Redraw when keypoints arrive or showKeypoints changes
watch(() => props.image.kpStatus,    () => drawOverlay())
watch(() => props.image.keypoints,   () => drawOverlay(), { deep: false })
watch(() => props.showKeypoints,     () => drawOverlay())
watch(() => props.showMask,          () => drawOverlay())
watch(() => props.showDepth,         () => drawOverlay())
watch(() => props.showGcps,          () => drawOverlay())
watch(() => props.gcps,              () => drawOverlay(), { deep: true })
watch(() => props.selectedGcpId,     () => drawOverlay())
watch(() => props.fiducialObs,       () => drawOverlay(), { deep: true })
watch(() => props.isFilm,            () => drawOverlay())
watch(() => props.showFiducials,     () => drawOverlay())
watch(() => props.fiducialMarks,     () => drawOverlay(), { deep: true })

// Entering edit mode arms the brush; leaving drops the tool + any in-flight rect.
watch(() => props.maskEdit, (on) => {
  tool.value = on ? 'brush' : null
  if (!on) rectDrag = null
  drawOverlay()
})
watch(tool, () => { rectDrag = null; drawOverlay() })

// Sync mask canvas when parent clears or replaces the mask externally
watch(() => props.image.mask, (mask, prev) => {
  if (mask === prev) return
  if (mask?.dataUrl && maskOffscreen) {
    loadMaskFromDataUrl(mask.dataUrl)
  } else if (!mask && maskOffscreen) {
    maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
    hasMask.value = false
    drawOverlay()
  }
})

// Sync depth canvas when parent clears or replaces the depth map externally
watch(() => props.image.depth, (depth, prev) => {
  if (depth === prev) return
  if (depth?.dataUrl && depthOffscreen) {
    loadDepthFromDataUrl(depth.dataUrl)
  } else if (!depth && depthOffscreen) {
    depthOffscreen.getContext('2d').clearRect(0, 0, depthOffscreen.width, depthOffscreen.height)
    hasDepth.value = false
    drawOverlay()
  }
})

// Mask-edit keyboard shortcuts. Instances are kept alive per tab via v-show, so
// gate on being the *visible* one (offsetParent is null while display:none) and
// on edit mode; skip while typing in a field. Escape is handled globally in
// App.vue (it must yield to open modals first).
function onKeydown(e) {
  if (!props.maskEdit || container.value?.offsetParent === null) return
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  const k = e.key.toLowerCase()
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redoMask() : undoMask(); return }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redoMask(); return }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if      (k === 'b') tool.value = 'brush'
  else if (k === 'e') tool.value = 'erase'
  else if (k === 'r') tool.value = 'rect'
  else if (k === 'i') invertMask()
  else if (e.key === '[') brushRadius.value = Math.max(4, brushRadius.value - 4)
  else if (e.key === ']') brushRadius.value = Math.min(80, brushRadius.value + 4)
  else return
  drawOverlay()
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => fit())
  if (container.value) resizeObserver.observe(container.value)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  document.removeEventListener('keydown', onKeydown)
})

defineExpose({ fit, zoomIn, zoomOut, triggerMaskImport, clearMask, triggerDepthImport, clearDepth })
</script>

<template>
  <div class="image-viewer">
    <input ref="maskFileInput" type="file" accept="image/*" hidden @change="onMaskFileChange" />
    <input ref="depthFileInput" type="file" accept="image/*" hidden @change="onDepthFileChange" />

    <div
      ref="container"
      class="viewport"
      :class="{
        grabbing: dragging && (!maskEdit || !tool),
        drawing: maskEdit && (tool === 'brush' || tool === 'erase'),
        crosshair: maskEdit && tool === 'rect',
      }"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @dblclick="(!maskEdit || !tool) && fit()"
      @contextmenu="onContextMenu"
    >
      <img
        v-if="!image.previewPending && !image.previewFailed"
        ref="imgEl"
        :src="image.url"
        :alt="image.name"
        class="image"
        :class="{ pending: !imageReady }"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        draggable="false"
        @load="onImgLoad"
      />
      <div v-else-if="image.previewFailed" class="image-pending image-error" title="Preview unavailable — decode failed">
        Preview unavailable
      </div>
      <div v-else class="image-pending" title="Decoding image…">
        <span class="spinner" />
      </div>

      <canvas ref="overlayCanvas" class="overlay-canvas" />

      <MaskToolbar
        v-if="maskEdit"
        :tool="tool"
        :brush-radius="brushRadius"
        :opacity="maskOpacity"
        :has-mask="hasMask"
        :can-undo="canUndo"
        :can-redo="canRedo"
        @set-tool="(t) => (tool = t)"
        @update:brush-radius="(r) => (brushRadius = r)"
        @update:opacity="(o) => { maskOpacity = o; drawOverlay() }"
        @invert="invertMask"
        @undo="undoMask"
        @redo="redoMask"
        @import="triggerMaskImport"
        @clear="clearMask"
        @close="emit('exit-mask-edit')"
      />

      <!-- Right-click context menu (general → GCP chooser sub-mode). -->
      <div v-if="menu" class="ctx-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @mousedown.stop @contextmenu.prevent>
        <template v-if="menu.mode === 'main'">
          <button class="ctx-item add" @click="menuAddGcp">Add GCP here…</button>
          <button v-if="isFilm" class="ctx-item add" @click="menuAddFiducial">Mark fiducial…</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="menuCopyCoords">Copy pixel (X,&nbsp;Y)</button>
          <button class="ctx-item" @click="menuCopyColor">Copy color (RGB)</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="menuZoomIn">Zoom in here</button>
          <button class="ctx-item" @click="menuFit">Fit to view</button>
        </template>
        <template v-else-if="menu.mode === 'fiducial'">
          <div class="ctx-hd">Mark fiducial here</div>
          <template v-if="fiducialMarks.length">
            <button
              v-for="m in fiducialMarks"
              :key="m.id"
              class="ctx-item"
              @click="menuMarkFiducial(m.id)"
            >{{ markedFidIds.has(m.id) ? '✓ ' : '' }}{{ m.id }}<span class="ctx-pos">{{ fidMarkPos.get(m.id) }}</span></button>
          </template>
          <div v-else class="ctx-sub">No marks defined — add them in the Sensor table.</div>
          <div class="ctx-sep"></div>
          <button class="ctx-item back" @click="menuBack">‹ Back</button>
        </template>
        <template v-else>
          <div class="ctx-hd">Add ground control point</div>
          <button class="ctx-item add" @click="menuNewGcp">＋ New GCP here</button>
          <template v-if="allGcps.length">
            <div class="ctx-sub">Assign to existing</div>
            <button
              v-for="g in allGcps"
              :key="g.id"
              class="ctx-item"
              @click="menuAssign(g.id)"
            >{{ g.name }}</button>
          </template>
          <div class="ctx-sep"></div>
          <button class="ctx-item back" @click="menuBack">‹ Back</button>
        </template>
      </div>

      <div class="hud">
        <span>{{ Math.round(scale * 100) }}%</span>
        <button title="Fit to view" @click.stop="fit">Fit</button>
      </div>
    </div>

    <div class="status-bar">
      <template v-if="hoverPx">
        <span class="coord">X&nbsp;{{ hoverPx.x }}</span>
        <span class="sep">|</span>
        <span class="coord">Y&nbsp;{{ hoverPx.y }}</span>
        <template v-if="hoverPx.r !== null">
          <span class="sep">|</span>
          <span
            class="swatch"
            :style="{ background: `rgb(${hoverPx.r},${hoverPx.g},${hoverPx.b})` }"
          ></span>
          <span class="channel r">R&nbsp;{{ hoverPx.r }}</span>
          <span class="channel g">G&nbsp;{{ hoverPx.g }}</span>
          <span class="channel b">B&nbsp;{{ hoverPx.b }}</span>
        </template>
        <template v-if="hoverPx.masked !== null">
          <span class="sep">|</span>
          <span class="masked" :class="{ on: hoverPx.masked }">Masked&nbsp;{{ hoverPx.masked ? '✓' : '—' }}</span>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.image-viewer {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  user-select: none;
}

.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  cursor: grab;
}

.viewport.grabbing  { cursor: grabbing; }
.viewport.drawing   { cursor: none; }
.viewport.crosshair { cursor: crosshair; }

.ctx-menu {
  position: absolute;
  z-index: 20;
  min-width: 180px;
  max-height: 70%;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  padding: 4px;
}

.ctx-hd {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  padding: 4px 8px 2px;
}

.ctx-sub {
  font-size: 10px;
  color: var(--text-dim);
  padding: 6px 8px 2px;
}

.ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 2px;
}

.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 8px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-item:hover { background: var(--hover-bg); }
.ctx-item.add { color: var(--accent, #5cf); font-weight: 500; }
.ctx-item.back { color: var(--text-dim); }
.ctx-pos { float: right; margin-left: 12px; color: var(--text-dim); font-size: 11px; }

.image {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  image-rendering: auto;
  will-change: transform;
}

/* Hidden until fit() has scaled it — avoids a flash of the image at native
   (possibly huge) resolution before the transform applies. */
.image.pending {
  visibility: hidden;
}

.image-pending {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}

.image-pending .spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--panel-border);
  border-top-color: var(--accent, #5cf);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.image-pending.image-error {
  color: var(--text-dim);
  font-size: 13px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.overlay-canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.hud {
  position: absolute;
  bottom: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
}

.hud button {
  background: none;
  border: 1px solid var(--panel-border);
  color: var(--text);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.hud button:hover { background: var(--hover-bg); }

.status-bar {
  flex-shrink: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 11px;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Mono', monospace;
  color: var(--text);
  background: var(--panel);
  border-top: 1px solid var(--panel-border);
}

.coord { color: var(--text); letter-spacing: 0.02em; }
.sep   { color: var(--panel-border); }

.swatch {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  flex-shrink: 0;
}

.channel     { letter-spacing: 0.02em; }
.channel.r   { color: #e07070; }
.channel.g   { color: #70c070; }
.channel.b   { color: #6090e0; }
.masked      { color: var(--text-dim); letter-spacing: 0.02em; }
.masked.on   { color: #ff8a8a; }
</style>
