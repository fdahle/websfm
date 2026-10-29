<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { clipLineToRect } from '../../core/sfm/gcpGuides.js'
import { segmentForget } from '../../workers/computeClient.js'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { copyToClipboard } from '../../composables/useToasts.js'
import { useImageViewport } from '../../composables/useImageViewport.js'
import { useMaskEditor } from '../../composables/useMaskEditor.js'
import { useDepthOverlay } from '../../composables/useDepthOverlay.js'
import { useImageKeypoints } from '../../composables/useImageKeypoints.js'
import { useFiducialFit } from '../../composables/useFiducialFit.js'
import { bitmapPixel } from '../../utils/imageViewport.js'
import { needsPyramid } from '../../core/io/rasterPyramid.js'
import {
  overlayView,
  beginOverlayFrame,
  paintRaster,
  paintRampLegend,
  paintResidualLegend,
  paintKeypoints,
  paintResiduals,
  paintGcpGuides,
  paintGcps,
  paintFiducials,
  paintLoupe,
  paintBrushCursor,
  paintRectPreview,
  KEYPOINT_LEGEND,
  DEPTH_LEGEND,
} from '../../utils/imageOverlay.js'
import MaskToolbar from './MaskToolbar.vue'
import GcpToolbar from './GcpToolbar.vue'
import ImageContextMenu from './ImageContextMenu.vue'
import ZoomField from './ZoomField.vue'

const props = defineProps({
  image: { type: Object, required: true },
  showKeypoints: { type: Boolean, default: false },
  showMask: { type: Boolean, default: false },
  showDepth: { type: Boolean, default: false },
  showGcps: { type: Boolean, default: false },
  gcps: { type: Array, default: () => [] }, // [{ id, name, px, py, reprojPx? }] observations on this image
  // Guided marking (core/sfm/gcpGuides.js): predicted position of GCPs *not yet*
  // marked on this image — [{ gcpId, name, kind:'point', u, v } | { gcpId, name,
  // kind:'line', line:[a,b,c] }], all in native image pixels.
  gcpGuides: { type: Array, default: () => [] },
  allGcps: { type: Array, default: () => [] }, // [{ id, name }] every GCP, for the right-click "assign" menu
  selectedGcpId: { type: String, default: null },
  maskEdit: { type: Boolean, default: false }, // mask-edit mode (floating toolbar)
  gcpEdit: { type: Boolean, default: false }, // GCP-edit mode: click to add/mark a GCP
  // Film sensor (F4): the sensor's calibrated fiducial marks + this image's
  // clicked observations. isFilm gates the "Mark fiducial…" menu + overlay.
  isFilm: { type: Boolean, default: false },
  showFiducials: { type: Boolean, default: false }, // overlay toggle for fiducial marks
  fiducialMarks: { type: Array, default: () => [] }, // [{ id, xMm, yMm }]
  fiducialObs: { type: Array, default: () => [] }, // [{ fidId, px, py }]
  // The calibration's scan→mm model: reconstruction fits exactly this one, so the
  // live residuals must too (an affine readout misreports a conformal/projective fit).
  fiducialTransform: { type: String, default: 'affine' },
  // Reprojection residual overlay (WS3): per-observation vectors in native image
  // pixels — [{ px, py, du, dv, mag }] (du,dv = observation − projection).
  showResiduals: { type: Boolean, default: false },
  residuals: { type: Array, default: () => [] },
  // Project scene type ('aerial' | 'object' | null). It only orders the two
  // create actions in the right-click chooser — an object project has no
  // georeference, so a marker is what it is almost always marking.
  sceneType: { type: String, default: null },
})

// Which point kind this scene type creates by default. Never a gate: both kinds
// stay one click away in every project.
const defaultPointRole = computed(() => (props.sceneType === 'object' ? 'marker' : 'control'))

// Which kind the NEXT click-to-create makes, while nothing is selected. Local to
// the viewport (it is a pointer mode, not project state) and re-seeded from the
// scene type whenever that changes.
const pendingNewRole = ref(defaultPointRole.value)
watch(defaultPointRole, (r) => {
  pendingNewRole.value = r
})
// The toolbar's "＋ New control" / "＋ New marker" both mean "deselect, and create
// THIS kind next" — so they set the mode and clear the target in one action.
function onSelectNewRole(role) {
  pendingNewRole.value = role === 'marker' ? 'marker' : 'control'
  emit('select-gcp', null)
}

// mark-gcp: assign this pixel to an existing GCP { gcpId, px, py }.
// add-gcp:  create a new reference point marked at this pixel { px, py, role }.
//           `role` is 'control' (surveyed ground control) or 'marker' (a scale-bar
//           endpoint with no surveyed position) — the chooser asks explicitly
//           rather than always creating a GCP.
// mark-fiducial: assign this pixel to a fiducial mark { fidId, px, py }.
// exit-mask-edit: user closed the mask toolbar (×) — parent owns the maskEdit flag.
const emit = defineEmits([
  'update-mask',
  'update-depth',
  'mark-gcp',
  'add-gcp',
  'select-gcp',
  'delete-gcp',
  'mark-fiducial',
  'exit-mask-edit',
  'exit-gcp-edit',
])

// The <img>'s @error (a blob: URL can outlive the file behind it, and the store
// heals it from OPFS or flags the image — see reportImageLoadError), and the
// on-demand keypoint reads.
const imagesStore = useImagesStore()

// Ids of GCPs already marked on this image, shown with a dot in the GCP-edit
// toolbar's target list.
const markedGcpIds = computed(() => (props.gcps ?? []).map((g) => g.id).filter((id) => id != null))

// ── Pieces ────────────────────────────────────────────────────────────────────
// Pan/zoom + native frame (useImageViewport), the mask editor with Smart Select
// (useMaskEditor), the depth overlay (useDepthOverlay), the keypoint set
// (useImageKeypoints), the live fiducial fit (useFiducialFit), the overlay painters
// (utils/imageOverlay.js) and the right-click menu (ImageContextMenu.vue). What
// stays here is the wiring, the pointer router, the overlay compositor and the
// hover readout.
//
// ORDER MATTERS below: Vue runs watchers that one change triggers in creation
// order. useImageViewport's url/meta watchers must precede useMaskEditor's
// (editable / maskEdit / tool / uuid / mask) — as they did in the single file —
// so that, e.g., an image switch has cleared the frame before the uuid watcher
// decides whether to re-encode for Smart Select.

const container = ref(null)
const imgEl = ref(null)
const overlayCanvas = ref(null)

const {
  scale,
  tx,
  ty,
  imageReady,
  frame,
  editable,
  refreshFrame,
  fit,
  zoomAt,
  zoomIn,
  zoomOut,
  zoomTo,
  getViewportCoords,
  toImagePixel,
  observeResize,
  disconnectResize,
} = useImageViewport({
  container,
  imgEl,
  image: () => props.image,
  onViewChange: drawOverlay,
  // Late TIFF metadata re-derived the frame: rebuild the (native-sized) mask canvas.
  onFrameChange: () => initMaskCanvas(),
})

// A very large scan (a tiled pyramid, core/io/rasterPyramid.js): the view only
// ever has its reduced display copy, so `editable` never turns on. Painting and
// marking by hand are unavailable; the mask is shown and whole-mask actions work.
const largeScan = computed(
  () => !!frame.value?.exact && (!!props.image.pyramidIndex || needsPyramid(frame.value.width, frame.value.height)),
)

const { fidResidual, markedFidIds, fidMarkPos, fidGhosts } = useFiducialFit({
  isFilm: () => props.isFilm,
  marks: () => props.fiducialMarks,
  obs: () => props.fiducialObs,
  transform: () => props.fiducialTransform,
})

// Depth-map overlay (its own native-sized canvas + import/export/clear).
// `depthCanvas` is what renderOverlay blits; the rest is the ribbon's depth buttons.
const { depthFileInput, depthCanvas, hasDepth, initDepthCanvas, triggerDepthImport, onDepthFileChange, clearDepth } =
  useDepthOverlay({ frame, image: () => props.image, drawOverlay, emit })

const { keypoints, keypointRange } = useImageKeypoints({
  image: () => props.image,
  show: () => props.showKeypoints,
  store: imagesStore,
})

const {
  maskFileInput,
  hasMask,
  tool,
  brushRadius,
  maskOpacity,
  canUndo,
  canRedo,
  smartStatus,
  smartHasPreview,
  smartPreviewCanvas,
  smartClick,
  discardSmart,
  canvas: maskCanvas,
  rect: maskRect,
  isDrawing,
  initMaskCanvas,
  maskedAt,
  flushMask,
  beginStroke,
  continueStroke,
  endStroke,
  beginRect,
  updateRect,
  cancelRect,
  commitRect,
  undoMask,
  redoMask,
  invertMask,
  clearMask,
  commitSmart,
  triggerMaskImport,
  onMaskFileChange,
  onKeydown,
} = useMaskEditor({
  image: () => props.image,
  maskEdit: () => props.maskEdit,
  viewport: { scale, tx, ty, frame, editable },
  drawOverlay,
  emit,
  // Instances are kept alive per tab via v-show: offsetParent is null while hidden.
  isVisible: () => container.value?.offsetParent !== null,
  largeScan: () => largeScan.value,
})

// Every overlay input redraws: prop toggles and data. The GCP and fiducial lists
// are watched deep (an edit inside them must repaint), the rest shallow (a large
// residual set is replaced, never edited in place). All getters, never a ref/reactive source: one of those would force the whole
// group to fire on any dep trigger (e.g. a record replaced with the same
// kpStatus), not only on a changed value as the separate watchers did.
watch(
  [
    () => keypoints.value,
    () => props.image.kpStatus,
    () => props.showKeypoints,
    () => props.showMask,
    () => props.showDepth,
    () => props.showGcps,
    () => props.gcpGuides,
    () => props.gcpEdit,
    () => props.selectedGcpId, // gcpEdit gates the guides too
    () => props.isFilm,
    () => props.showFiducials,
    () => props.showResiduals,
    () => props.residuals,
  ],
  drawOverlay,
)
watch([() => props.gcps, () => props.fiducialObs, () => props.fiducialMarks], drawOverlay, { deep: true })

// ── Overlay canvas ────────────────────────────────────────────────────────────

// Every overlay input (the prop watchers above, plus pan/zoom/paint) funnels
// through here, and one user action commonly trips several at once — a mask-edit
// toggle moves `maskEdit`, `showMask` and `tool` together, and a drag fires per
// mousemove. Coalesce to at most one repaint per animation frame; `renderOverlay`
// below is the actual draw and is never called directly. Same pattern as
// App.vue's queueGcpGuidesRefresh.
let overlayFrame = 0
function drawOverlay() {
  if (overlayFrame) return
  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = 0
    renderOverlay()
  })
}

// The actual repaint — which layers are on, bottom to top. Call `drawOverlay()`
// instead — it coalesces to one frame.
function renderOverlay() {
  const c = overlayCanvas.value
  const f = frame.value
  if (!c || !f || !container.value) return

  const w = container.value.clientWidth
  const h = container.value.clientHeight
  if (!w || !h) return

  const ctx = beginOverlayFrame(c, w, h, window.devicePixelRatio || 1)
  // Native-pixel overlays map through the native frame (f.width/height), never the
  // bitmap's naturalWidth — they differ while a TIFF preview is shown. `exact` is
  // false only for a preview whose native size is still unknown; native-pixel
  // overlays are skipped then rather than misplaced.
  const view = overlayView({ w, h, tx: tx.value, ty: ty.value, scale: scale.value, frame: f })
  const exact = f.exact

  // Colour legends stack up from the bottom-left corner (one row per active overlay).
  let legendSlot = 0

  // Depth — colorized semi-transparent overlay at image position.
  if (depthCanvas.value && hasDepth.value && props.showDepth) {
    paintRaster(ctx, view, depthCanvas.value, 0.6)
    paintRampLegend(ctx, view, legendSlot++, DEPTH_LEGEND)
  }

  // Mask — red semi-transparent overlay at image position. Always shown while
  // editing (regardless of the view toggle) so you can see what you're painting.
  const mask = maskCanvas()
  if (mask && hasMask.value && (props.showMask || props.maskEdit)) {
    paintRaster(ctx, view, mask, maskOpacity.value)
  }

  // Smart Select candidate — cyan preview overlay (uncommitted) while the tool is
  // active; smoothed, it is the low-res encoder raster.
  if (props.maskEdit && tool.value === 'smart' && smartPreviewCanvas.value) {
    paintRaster(ctx, view, smartPreviewCanvas.value, 0.55, { smooth: true })
  }

  // Keypoints — colour-coded dots (cold=blue → hot=red by SIFT response).
  if (props.showKeypoints && keypointRange.value) {
    paintKeypoints(ctx, view, keypoints.value, keypointRange.value)
    paintRampLegend(ctx, view, legendSlot++, KEYPOINT_LEGEND)
  }

  // Reprojection residual vectors (WS3), amplified ×25.
  if (props.showResiduals && props.residuals?.length && exact) {
    paintResiduals(ctx, view, props.residuals)
    paintResidualLegend(ctx, view, legendSlot++)
  }

  // Guided marking, under the real markers. Gated on `gcpEdit` alone (not
  // showGcps): a guide is an aid for *placing* a mark, so it has no business on
  // screen once the user leaves edit mode. App.vue stops computing them on the
  // same condition.
  if (props.gcpEdit && props.gcpGuides?.length && exact) {
    paintGcpGuides(ctx, view, props.gcpGuides, props.selectedGcpId, clipLineToRect)
  }

  // GCP markers — observation pixel positions on this image.
  if (props.showGcps && props.gcps?.length && exact) {
    paintGcps(ctx, view, props.gcps, props.selectedGcpId)
  }

  // Fiducial markers (F4) + ghost guides for the marks not placed yet.
  if (props.showFiducials && props.isFilm && props.fiducialObs?.length && exact) {
    paintFiducials(ctx, view, props.fiducialObs, fidResidual.value, fidGhosts.value)
  }

  // Magnifier loupe — a zoomed inset around the cursor while working with GCPs,
  // so marks can be placed precisely without zooming the whole view. Drawn last
  // (on top), pinned to a corner so it never covers the point being marked.
  if ((props.showGcps || (props.showFiducials && props.isFilm)) && mousePos) {
    paintLoupe(ctx, view, imgEl.value, frame.value, mousePos)
  }

  // Brush cursor circle (brush/eraser tools).
  if (props.maskEdit && editable.value && (tool.value === 'brush' || tool.value === 'erase') && mousePos) {
    paintBrushCursor(ctx, mousePos, brushRadius.value, tool.value === 'erase')
  }

  // In-flight rectangle preview (dashed; blue while Alt = erase).
  const rect = maskRect()
  if (rect) paintRectPreview(ctx, view, rect)
}

// ── Pointer router ────────────────────────────────────────────────────────────
// One owner for mouse input: rect / brush / smart / gcp / pan, chosen on press.
// Smart and GCP presses arm a pan AND a pending click through the same drag-start
// state as a plain pan; a move past the click threshold turns them into a pan.

const dragging = ref(false)
const hoverPx = ref(null)

let smartDown = null // { x, y, alt } pending click-vs-drag while Smart tool active
let smartMoved = false // pointer moved past the click threshold → it's a pan, not a click
let gcpDown = null // { x, y } pending click-vs-drag while GCP-edit mode active
let gcpMoved = false // pointer moved past the click threshold → it's a pan, not a GCP click
let mousePos = null // { x, y } screen coords for brush cursor / loupe
let startX = 0,
  startY = 0,
  startTx = 0,
  startTy = 0
let offscreenCtx = null // the displayed bitmap, for colour sampling

// Right-click context menu (ImageContextMenu.vue): { x, y, sx, sy, px, py, mode } | null.
const menu = ref(null)
const ZOOM_HERE_FACTOR = 1.8

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
    sx: x,
    sy: y,
    px: pix.px,
    py: pix.py,
    mode: 'main',
  }
}

function closeMenu() {
  menu.value = null
}

// "Copy color (RGB)": the bitmap pixel holding the clicked native pixel.
function onMenuCopyColor({ px, py }) {
  if (offscreenCtx && frame.value) {
    const { x, y } = bitmapPixel(px, py, frame.value)
    const d = offscreenCtx.getImageData(x, y, 1, 1).data
    copyToClipboard(`rgb(${d[0]}, ${d[1]}, ${d[2]})`, 'color')
  }
}

function onMouseDown(e) {
  if (menu.value && e.button === 0) {
    closeMenu()
    return
  }
  // Until the full-resolution bitmap is in (`editable`), presses just pan.
  const activeTool = props.maskEdit && editable.value ? tool.value : null
  if (activeTool === 'rect' && e.button === 0) {
    const { x, y } = getViewportCoords(e)
    beginRect(toImagePixel(x, y), e.altKey)
    drawOverlay()
  } else if ((activeTool === 'brush' || activeTool === 'erase') && e.button === 0) {
    const { x, y } = getViewportCoords(e)
    beginStroke(x, y)
    drawOverlay()
  } else if (activeTool === 'smart' && e.button === 0) {
    // Arm BOTH a pan and a pending segment click — a real drag pans, a click (no
    // movement past the threshold, decided in onMouseUp) segments. So the Smart
    // tool still lets you move around without a modifier.
    const { x, y } = getViewportCoords(e)
    smartDown = { x, y, alt: e.altKey }
    smartMoved = false
    dragging.value = true
    startX = e.clientX
    startY = e.clientY
    startTx = tx.value
    startTy = ty.value
  } else if (props.gcpEdit && editable.value && e.button === 0) {
    // Like the Smart tool: arm a pending click AND a pan; a real drag pans, a click
    // (no movement past the threshold, decided in onMouseUp) places/marks a GCP.
    const { x, y } = getViewportCoords(e)
    gcpDown = { x, y }
    gcpMoved = false
    dragging.value = true
    startX = e.clientX
    startY = e.clientY
    startTx = tx.value
    startTy = ty.value
  } else if (e.button === 0) {
    dragging.value = true
    startX = e.clientX
    startY = e.clientY
    startTx = tx.value
    startTy = ty.value
  }
}

function onMouseMove(e) {
  const { x, y } = getViewportCoords(e)
  mousePos = { x, y }

  if (maskRect()) {
    updateRect(toImagePixel(x, y), e.altKey)
  } else if (isDrawing() && tool.value) {
    continueStroke(x, y)
  } else if (dragging.value) {
    // Once the pointer moves past a small threshold, a Smart-tool press is a pan,
    // not a segment click.
    if (smartDown && !smartMoved && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) smartMoved = true
    if (gcpDown && !gcpMoved && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) gcpMoved = true
    tx.value = startTx + (e.clientX - startX)
    ty.value = startTy + (e.clientY - startY)
  }

  updateHover(x, y)
  drawOverlay()
}

async function onMouseUp() {
  // Smart tool: a press that didn't drag is a segment click; a drag was a pan.
  if (smartDown) {
    const down = smartDown,
      moved = smartMoved
    smartDown = null
    smartMoved = false
    dragging.value = false
    if (!moved && editable.value) {
      const pix = toImagePixel(down.x, down.y)
      if (pix) await smartClick(pix.px, pix.py, down.alt) // Alt-click = refine (negative)
    }
    return
  }
  // GCP-edit: a press that didn't drag places a GCP; a drag was a pan.
  if (gcpDown) {
    const down = gcpDown,
      moved = gcpMoved
    gcpDown = null
    gcpMoved = false
    dragging.value = false
    if (!moved && editable.value) {
      const pix = toImagePixel(down.x, down.y)
      if (pix) {
        // A selected GCP → mark this image's observation of it; otherwise create a
        // new GCP here (parent owns both, same handlers as the right-click menu).
        if (props.selectedGcpId != null) emit('mark-gcp', { gcpId: props.selectedGcpId, px: pix.px, py: pix.py })
        // Click-to-create with nothing selected defaults to whatever this scene
        // type is usually marking: control for aerial, markers for object capture.
        else emit('add-gcp', { px: pix.px, py: pix.py, role: pendingNewRole.value })
      }
    }
    return
  }
  if (maskRect()) {
    await commitRect()
    return
  }
  if (isDrawing()) {
    const exporting = endStroke() // null when the stroke never touched the image
    if (exporting) await exporting
  }
  dragging.value = false
}

function onMouseLeave() {
  dragging.value = false
  cancelRect() // cancel an in-flight rectangle rather than guessing its corner
  smartDown = null
  smartMoved = false // cancel a pending Smart click/pan
  gcpDown = null
  gcpMoved = false // cancel a pending GCP click/pan
  if (isDrawing()) endStroke()
  mousePos = null
  hoverPx.value = null
  drawOverlay()
}

function onWheel(e) {
  e.preventDefault()
  closeMenu() // its anchor pixel would drift under the zoom
  const { x, y } = getViewportCoords(e)
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, x, y)
}

// ── Hover readout (status bar) ────────────────────────────────────────────────

// Pixel under the cursor. Coordinates are native; the colour is sampled from the
// bitmap pixel holding that native pixel (a preview's is approximate).
function updateHover(x, y) {
  const px = Math.floor((x - tx.value) / scale.value)
  const py = Math.floor((y - ty.value) / scale.value)
  const f = frame.value
  if (f?.exact && px >= 0 && py >= 0 && px < f.width && py < f.height) {
    const info = { x: px, y: py, r: null, g: null, b: null, masked: null }
    if (offscreenCtx) {
      const b = bitmapPixel(px, py, f)
      const pixel = offscreenCtx.getImageData(b.x, b.y, 1, 1).data
      info.r = pixel[0]
      info.g = pixel[1]
      info.b = pixel[2]
    }
    // Whether this pixel is excluded by the mask (opaque on the mask canvas).
    info.masked = maskedAt(px, py)
    hoverPx.value = info
  } else {
    hoverPx.value = null
  }
}

function setupOffscreenCanvas() {
  const img = imgEl.value
  if (!img || !img.naturalWidth) return
  try {
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    offscreenCtx = c.getContext('2d')
    offscreenCtx.drawImage(img, 0, 0)
  } catch {
    offscreenCtx = null
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function onImgLoad() {
  refreshFrame()
  // fit() reveals the image (imageReady). In a hidden tab it defers instead, and
  // the ResizeObserver fits + reveals once the tab is shown.
  fit()
  setupOffscreenCanvas()
  initMaskCanvas()
  // Native-sized from the frame; a no-op for a preview frame, so the depth canvas
  // is only built once the bitmap is the full-resolution one.
  initDepthCanvas()
}

onMounted(() => {
  observeResize()
  document.addEventListener('keydown', onKeydown)
})

// Teardown order is deliberate: flush pending mask edits first (the tab may be
// closed mid-edit), then stop the repaint/resize/key machinery, then free SAM2.
onBeforeUnmount(() => {
  flushMask() // persist any pending mask edits if the tab is closed mid-edit
  if (overlayFrame) cancelAnimationFrame(overlayFrame)
  disconnectResize()
  document.removeEventListener('keydown', onKeydown)
  if (props.image?.uuid) segmentForget(props.image.uuid) // free the SAM2 embedding
})

defineExpose({ fit, zoomIn, zoomOut, triggerMaskImport, clearMask, triggerDepthImport, clearDepth })
</script>

<template>
  <div class="image-viewer">
    <input ref="maskFileInput" type="file" accept="image/*,.tif,.tiff" hidden @change="onMaskFileChange" />
    <input ref="depthFileInput" type="file" accept="image/*" hidden @change="onDepthFileChange" />

    <div
      ref="container"
      class="viewport"
      :class="{
        grabbing: dragging && (!maskEdit || !tool || !editable) && (!gcpEdit || !editable),
        drawing: editable && maskEdit && (tool === 'brush' || tool === 'erase'),
        crosshair: editable && ((maskEdit && (tool === 'rect' || tool === 'smart')) || gcpEdit),
      }"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @dblclick="(!maskEdit || !tool || !editable) && (!gcpEdit || !editable) && fit()"
      @contextmenu="onContextMenu"
    >
      <img
        v-if="!image.previewPending && !image.previewFailed"
        ref="imgEl"
        :src="image.url"
        :alt="image.name"
        class="image"
        :class="{ pending: !imageReady }"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale / (frame?.bitmapScale ?? 1)})` }"
        draggable="false"
        @load="onImgLoad"
        @error="imagesStore.reportImageLoadError(image.id)"
      />
      <div
        v-else-if="image.previewFailed"
        class="image-pending image-error"
        :title="
          image.previewFailReason === 'source-lost'
            ? 'The file this image was loaded from is no longer readable, and project storage has no usable copy. Re-add the file.'
            : 'Preview unavailable — decode failed'
        "
      >
        {{ image.previewFailReason === 'source-lost' ? 'Image file no longer available' : 'Preview unavailable' }}
      </div>
      <div v-else class="image-pending" title="Decoding image…">
        <span class="spinner busy-motion" />
      </div>

      <canvas ref="overlayCanvas" class="overlay-canvas" />

      <!-- Only the low-res TIFF preview is in: marks/masks would land imprecisely
           and the mask canvas is rebuilt when full resolution arrives. A very large
           scan never gets past its reduced copy, so say so instead of "waiting". -->
      <div v-if="(maskEdit || gcpEdit) && imageReady && !editable" class="edit-locked">
        <template v-if="!largeScan">Loading full resolution — editing resumes when it is ready</template>
        <template v-else-if="maskEdit">
          Painting isn't available on very large scans yet — use Import, Invert or Auto mask
        </template>
        <template v-else>Marking by hand isn't available on very large scans yet</template>
      </div>

      <MaskToolbar
        v-if="maskEdit"
        :tool="tool"
        :brush-radius="brushRadius"
        :opacity="maskOpacity"
        :has-mask="hasMask"
        :can-undo="canUndo"
        :can-redo="canRedo"
        :smart-status="smartStatus"
        :smart-has-preview="smartHasPreview"
        :paintable="editable || !largeScan"
        @set-tool="(t) => (tool = t)"
        @update:brush-radius="(r) => (brushRadius = r)"
        @update:opacity="
          (o) => {
            maskOpacity = o
            drawOverlay()
          }
        "
        @invert="invertMask"
        @undo="undoMask"
        @redo="redoMask"
        @import="triggerMaskImport"
        @clear="clearMask"
        @smart-commit="commitSmart"
        @smart-discard="discardSmart"
        @close="emit('exit-mask-edit')"
      />

      <GcpToolbar
        v-if="gcpEdit"
        :all-gcps="allGcps"
        :selected-id="selectedGcpId"
        :new-role="pendingNewRole"
        :marked-ids="markedGcpIds"
        @select="(id) => emit('select-gcp', id)"
        @select-new="onSelectNewRole"
        @delete="(id) => emit('delete-gcp', id)"
        @close="emit('exit-gcp-edit')"
      />

      <!-- Right-click context menu (general → GCP / fiducial chooser sub-modes). -->
      <ImageContextMenu
        v-model:menu="menu"
        :editable="editable"
        :is-film="isFilm"
        :fiducial-marks="fiducialMarks"
        :marked-fid-ids="markedFidIds"
        :fid-mark-pos="fidMarkPos"
        :all-gcps="allGcps"
        :default-point-role="defaultPointRole"
        @add-gcp="(p) => emit('add-gcp', p)"
        @mark-gcp="(p) => emit('mark-gcp', p)"
        @mark-fiducial="(p) => emit('mark-fiducial', p)"
        @copy-color="onMenuCopyColor"
        @zoom-in="(p) => zoomAt(ZOOM_HERE_FACTOR, p.sx, p.sy)"
        @fit="fit"
      />
    </div>

    <div class="status-bar">
      <template v-if="hoverPx">
        <span class="coord">X&nbsp;{{ hoverPx.x }}</span>
        <span class="sep">|</span>
        <span class="coord">Y&nbsp;{{ hoverPx.y }}</span>
        <template v-if="hoverPx.r !== null">
          <span class="sep">|</span>
          <span class="swatch" :style="{ background: `rgb(${hoverPx.r},${hoverPx.g},${hoverPx.b})` }"></span>
          <span class="channel r">R&nbsp;{{ hoverPx.r }}</span>
          <span class="channel g">G&nbsp;{{ hoverPx.g }}</span>
          <span class="channel b">B&nbsp;{{ hoverPx.b }}</span>
        </template>
        <template v-if="hoverPx.masked !== null">
          <span class="sep">|</span>
          <span class="masked" :class="{ on: hoverPx.masked }">Masked&nbsp;{{ hoverPx.masked ? '✓' : '—' }}</span>
        </template>
      </template>
      <!-- Zoom is status, and takes a typed value; Fit / Zoom in / out are ribbon
           commands (Picture ▸ View). -->
      <span class="spacer"></span>
      <ZoomField :scale="scale" @set="zoomTo" />
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

/* Checkerboard backdrop (same as the raster viewer) — makes the image edges and
   any transparency read clearly against the empty viewport. */
.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  cursor: grab;
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.1) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.1) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.1) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.1) 75%);
  background-size: 20px 20px;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
}

.viewport.grabbing {
  cursor: grabbing;
}
.viewport.drawing {
  cursor: none;
}
.viewport.crosshair {
  cursor: crosshair;
}

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
  to {
    transform: rotate(360deg);
  }
}

.overlay-canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.edit-locked {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}
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

.coord {
  color: var(--text);
  letter-spacing: 0.02em;
}
.sep {
  color: var(--panel-border);
}

.swatch {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  flex-shrink: 0;
}

.channel {
  letter-spacing: 0.02em;
}
.channel.r {
  color: #e07070;
}
.channel.g {
  color: #70c070;
}
.channel.b {
  color: #6090e0;
}
.masked {
  color: var(--text-dim);
  letter-spacing: 0.02em;
}
.masked.on {
  color: #ff8a8a;
}
</style>
