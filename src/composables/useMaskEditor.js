import { ref, computed, watch } from 'vue'
import { invertMaskPixels, anyExcluded, maskStorageSize } from '../core/mask.js'
import { maskFromFile } from '../workers/computeClient.js'
import { createRevision } from '../utils/revision.js'
import { viewerMayHandleKey } from '../utils/keyRouting.js'
import { useSmartSelect } from './useSmartSelect.js'

// The image viewer's mask editor (components/viewers/ViewerImage.vue): the
// native-resolution mask canvas, the edit tools (brush / erase / rectangle /
// invert / import / Smart Select commit), undo/redo, and getting the result to the
// store — deferred while mask-edit is open, flushed once when it closes.
//
// The component's pointer router stays the one owner of mouse input and calls in
// through the stroke/rectangle API below (beginStroke/continueStroke/endStroke,
// beginRect/updateRect/cancelRect/commitRect); renderOverlay reads `canvas()` and
// `rect()`. Keyboard shortcuts are `onKeydown`, registered by the component.
//
// Two invariants carry the async safety, keep them:
//   • `maskRev` (utils/revision.js): every mutation of the mask canvas bumps it, and
//     a mask decode or PNG export that resolves after a newer mutation is dropped.
//     Without it a late decode repaints a state the user already undid past, and a
//     stroke's pending export lands after Ctrl+Z and re-persists the undone stroke.
//   • `canvasSource`: the persisted mask Blob the canvas currently shows (or is
//     decoding): null = no mask, undefined = edited since. Lets the mask watcher
//     skip re-decoding the canvas's own export when the store echoes it back.
//
// Deps:
//   image       — getter returning the current image record (reads `.mask`, `.uuid`)
//   maskEdit    — getter: is mask-edit mode on (the parent owns the flag)
//   viewport    — useImageViewport's { scale, tx, ty, frame, editable }
//   drawOverlay — schedule an overlay repaint
//   emit        — component emit, for 'update-mask'
//   isVisible   — is this viewer the visible tab (instances are v-show-kept)
//   largeScan   — getter: is the image a very large scan (a tiled pyramid, shown
//                 only as a reduced copy that never turns full-resolution)
//
// A very large scan gets a REDUCED mask canvas (core/mask.js maskStorageSize, the
// size its mask is stored at) while the reduced copy is shown: the mask is visible
// and the whole-mask actions (import, invert, clear, undo/redo) work, but painting
// stays off — the pointer router only paints while `editable`, which a reduced copy
// never is.
const UNDO_MAX = 10

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

export function useMaskEditor({ image, maskEdit, viewport, drawOverlay, emit, isVisible, largeScan = () => false }) {
  const { scale, tx, ty, frame, editable } = viewport

  const maskFileInput = ref(null)
  const hasMask = ref(!!image().mask)

  // Tool state (local: the floating toolbar and this viewer are the only consumers;
  // per-tab persistence comes free from v-show-kept instances).
  // 'brush' | 'erase' | 'rect' | 'smart' | null (pan while editing). A tab opened
  // while mask edit is already on starts armed, as entering the mode does.
  const tool = ref(maskEdit() ? 'brush' : null)
  const brushRadius = ref(20) // screen pixels — constant on screen, ÷scale in image space
  const maskOpacity = ref(0.45) // red-overlay alpha while editing/viewing

  // Smart Select (SAM2 click-to-segment). The image is encoded once when the tool
  // is activated; each click decodes a *fresh* candidate segment (clicks are
  // independent — a plain click resets to one positive point at that spot), which
  // is previewed (cyan) until the user commits it into the red mask or discards it.
  const {
    smartStatus,
    smartHasPreview,
    smartPreviewCanvas,
    ensureEncoded,
    smartClick,
    buildCommitCanvas,
    discardSmart,
    resetSmart,
  } = useSmartSelect({ image, nativeSize: () => frame.value, drawOverlay })

  // Undo/redo as stacks of persisted mask Blobs (null = no mask). Snapshots are
  // the *previous* store value taken just before each committed change, so memory
  // cost is a handful of compressed PNG Blobs, not raw pixel buffers.
  const undoStack = ref([])
  const redoStack = ref([])
  let maskDirty = false // uncommitted mask edits pending a flush to the store on close

  let rectDrag = null // { x0, y0, x1, y1, erase } image-px corners of an in-flight rectangle
  let isDrawing = false
  let strokeHit = false // did the in-flight brush/erase stroke touch the image?

  let maskOffscreen = null // OffscreenCanvas at native image resolution (reduced for a large scan)
  let maskReduced = false // maskOffscreen is a large scan's reduced, view/whole-mask-only canvas
  const maskRev = createRevision()
  let canvasSource = null

  // ── Canvas ──────────────────────────────────────────────────────────────────

  // The mask canvas is NATIVE-sized. While only a preview bitmap is shown there is
  // no canvas at all (editing is off then — see `editable`): it is built when the
  // full-resolution image loads, so a mask is never created or persisted at the
  // preview's resolution. The exception is a very large scan, which never gets a
  // full-resolution bitmap: its canvas is at the mask's storage size.
  function initMaskCanvas() {
    maskRev.bump() // a decode aimed at the previous canvas is stale
    canvasSource = null
    const f = frame.value
    maskReduced = !!f && f.preview && f.exact && largeScan()
    if (!f || (f.preview && !maskReduced)) {
      maskOffscreen = null
      return
    }
    const s = maskReduced ? maskStorageSize(f.width, f.height) : { w: f.width, h: f.height }
    maskOffscreen = new OffscreenCanvas(s.w, s.h)
    if (image().mask?.blob) loadMaskBlob(image().mask.blob)
  }

  // Whole-mask actions (import, invert, clear, undo/redo): with the full-resolution
  // image, or on a large scan's reduced canvas. Painting checks `editable` alone.
  const wholeMaskOk = () => editable.value || (maskReduced && !!maskOffscreen && !!frame.value)

  // A canvas mutation other than a decode: any in-flight decode/export is now stale.
  function markMaskEdited() {
    maskRev.bump()
    canvasSource = undefined
  }

  // Masks travel as PNG Blobs (the store's `{ blob, url }` record; core/mask.js).
  // A decode REPLACES the canvas, so it takes a fresh revision; if anything touched
  // the canvas while it decoded (undo past it, a stroke, a clear), its result is
  // dropped. Resolves true when the blob was actually drawn.
  async function loadMaskBlob(blob) {
    if (!maskOffscreen) return false
    const rev = maskRev.bump()
    canvasSource = blob
    try {
      const bmp = await createImageBitmap(blob)
      if (!maskRev.isCurrent(rev) || !maskOffscreen) {
        bmp.close?.()
        return false
      }
      const ctx = maskOffscreen.getContext('2d')
      ctx.clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
      ctx.drawImage(bmp, 0, 0, maskOffscreen.width, maskOffscreen.height)
      bmp.close?.()
      hasMask.value = true
      drawOverlay()
      return true
    } catch {
      return false
    }
  }

  // Does a brush circle (image coords, radius r) overlap the image rectangle at
  // all? The mask canvas is exactly image-sized, so a stroke fully outside paints
  // zero pixels — without this test it would still flip hasMask + save an empty
  // mask. Uses the closest point on [0,w]×[0,h] to the circle centre.
  function circleIntersectsImage(cx, cy, r) {
    if (!maskOffscreen) return false
    const dx = cx - clamp(cx, 0, maskOffscreen.width)
    const dy = cy - clamp(cy, 0, maskOffscreen.height)
    return dx * dx + dy * dy <= r * r
  }

  // Paint or erase a circle at screen position onto the mask canvas. Brush radius
  // stays constant in screen space (divided by scale → image coords). Returns
  // whether the stroke actually touched the image (so a fully-outside stroke can
  // be discarded rather than committed as an empty mask).
  function paintAt(sx, sy) {
    if (!maskOffscreen || !editable.value) return false // native canvas only (not a large scan's)
    const imgX = (sx - tx.value) / scale.value
    const imgY = (sy - ty.value) / scale.value
    const r = brushRadius.value / scale.value
    if (!circleIntersectsImage(imgX, imgY, r)) return false
    markMaskEdited()
    const ctx = maskOffscreen.getContext('2d')

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

  // Whether native pixel (px, py) is excluded by the mask (opaque on the mask
  // canvas), or null when there is no mask to ask.
  // (px, py) are native; a large scan's reduced canvas is read at its own scale.
  function maskedAt(px, py) {
    if (!maskOffscreen || !hasMask.value) return null
    const f = frame.value
    if (maskReduced && f) {
      px = Math.min(maskOffscreen.width - 1, Math.floor((px * maskOffscreen.width) / f.width))
      py = Math.min(maskOffscreen.height - 1, Math.floor((py * maskOffscreen.height) / f.height))
    }
    return maskOffscreen.getContext('2d').getImageData(px, py, 1, 1).data[3] > 127
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────────
  // Push the *current persisted* mask (still the pre-change value — commits happen
  // after the snapshot) onto the undo stack. Every committed change (stroke end,
  // rectangle, invert, import, clear) snapshots first, so undo restores exactly
  // the states the store has seen.
  // A commit whose export was superseded (a new stroke began while the PNG encoded)
  // never reached the store, so the next commit would snapshot the same state again;
  // don't stack duplicates — undo then reverts the burst in one step.
  function snapshotForUndo() {
    const cur = image().mask?.blob ?? null
    const top = undoStack.value[undoStack.value.length - 1]
    if (!undoStack.value.length || top !== cur) undoStack.value.push(cur)
    if (undoStack.value.length > UNDO_MAX) undoStack.value.shift()
    redoStack.value = []
  }

  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  // Push the mask to the store. While mask-edit is open we DON'T persist every
  // commit (no OPFS write / log / sync per stroke or Smart click) — the store just
  // updates its in-memory copy (so undo/redo, overlay, and the sidebar badge stay
  // live) and we mark it dirty; the single flush happens when editing closes
  // (flushMask). Outside edit mode (ribbon/sidebar clear/import) we persist at once.
  function persistMask(blob) {
    if (maskEdit()) {
      maskDirty = true
      emit('update-mask', blob, false)
    } else emit('update-mask', blob, true)
  }

  // Persist the current in-memory mask once (on closing edit / unmount) if any
  // edit happened this session.
  function flushMask() {
    if (!maskDirty) return
    maskDirty = false
    emit('update-mask', image().mask?.blob ?? null, true)
  }

  // Restore a snapshot (a mask Blob, or null) onto the canvas and re-emit it as the
  // (deferred) mask.
  function applyMaskSnapshot(blob) {
    if (blob) {
      loadMaskBlob(blob)
    } else if (maskOffscreen) {
      markMaskEdited()
      canvasSource = null
      maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
      hasMask.value = false
      drawOverlay()
    }
    persistMask(blob)
  }

  function undoMask() {
    if (!wholeMaskOk() || !undoStack.value.length) return
    redoStack.value.push(image().mask?.blob ?? null)
    applyMaskSnapshot(undoStack.value.pop())
  }

  function redoMask() {
    if (!wholeMaskOk() || !redoStack.value.length) return
    undoStack.value.push(image().mask?.blob ?? null)
    applyMaskSnapshot(redoStack.value.pop())
  }

  // ── Commits ──────────────────────────────────────────────────────────────────

  // True when the mask canvas has no excluded pixels left (e.g. after erasing the
  // last of a mask). Reads the whole canvas, so only call on commits that can
  // empty it (erase/rect-erase/import) — a draw is trivially non-empty.
  function maskCanvasEmpty() {
    if (!maskOffscreen) return true
    const ctx = maskOffscreen.getContext('2d')
    const id = ctx.getImageData(0, 0, maskOffscreen.width, maskOffscreen.height)
    return !anyExcluded(id.data)
  }

  // Persist the current mask canvas. With `checkEmpty` (erase-type commits), first
  // tests whether anything is still masked and commits `null` (no mask) if not —
  // so erasing the last pixels clears the mask instead of saving an empty PNG.
  // The PNG encode is async: if the canvas changed while it ran (undo, a newer
  // stroke, a reload), this snapshot is stale and is dropped — persisting it would
  // revert the undo; a newer edit exports its own (superset) state anyway.
  async function exportMask(checkEmpty = false) {
    if (!maskOffscreen) return
    if (checkEmpty && maskCanvasEmpty()) {
      canvasSource = null
      hasMask.value = false
      persistMask(null)
      return
    }
    const rev = maskRev.current()
    const blob = await maskOffscreen.convertToBlob({ type: 'image/png' })
    if (!maskRev.isCurrent(rev)) return
    canvasSource = blob
    hasMask.value = true
    persistMask(blob)
  }

  // Brush/erase stroke, driven by the pointer router (screen coords).
  function beginStroke(sx, sy) {
    isDrawing = true
    strokeHit = false
    strokeHit = paintAt(sx, sy) || strokeHit
  }
  function continueStroke(sx, sy) {
    strokeHit = paintAt(sx, sy) || strokeHit
  }
  // Ends the stroke. A stroke that never touched the image is a no-op — don't save
  // an empty mask; an erase can empty the mask, so re-check on that path. Returns
  // the export's promise, or null when there was nothing to commit (the caller
  // awaits only a real export, as before the split).
  function endStroke() {
    isDrawing = false
    if (!strokeHit) return null
    snapshotForUndo()
    return exportMask(tool.value === 'erase')
  }

  // Rectangle, driven by the pointer router (native px from toImagePixel; a null
  // pixel — native size unknown — leaves it as it was).
  function beginRect(pix, erase) {
    if (pix) rectDrag = { x0: pix.px, y0: pix.py, x1: pix.px, y1: pix.py, erase }
  }
  function updateRect(pix, erase) {
    if (pix) {
      rectDrag.x1 = pix.px
      rectDrag.y1 = pix.py
      rectDrag.erase = erase
    }
  }
  function cancelRect() {
    rectDrag = null
  }

  async function commitRect() {
    if (!rectDrag || !maskOffscreen || !editable.value) {
      rectDrag = null
      return
    }
    const { x0, y0, x1, y1, erase } = rectDrag
    rectDrag = null
    const x = Math.min(x0, x1),
      y = Math.min(y0, y1)
    const w = Math.abs(x1 - x0),
      h = Math.abs(y1 - y0)
    if (w < 1 || h < 1) {
      drawOverlay()
      return
    }
    snapshotForUndo()
    markMaskEdited()
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
    if (!maskOffscreen || !wholeMaskOk()) return
    markMaskEdited()
    const ctx = maskOffscreen.getContext('2d')
    const id = ctx.getImageData(0, 0, maskOffscreen.width, maskOffscreen.height)
    const excluded = invertMaskPixels(id.data)
    ctx.putImageData(id, 0, 0)
    snapshotForUndo()
    hasMask.value = excluded > 0
    drawOverlay()
    if (excluded > 0) await exportMask()
    else {
      canvasSource = null
      persistMask(null)
    }
  }

  // Clear is undoable (snapshot first) — no confirm dialog needed anymore.
  function clearMask() {
    if (!maskOffscreen || !hasMask.value || !wholeMaskOk()) return
    snapshotForUndo()
    markMaskEdited()
    canvasSource = null
    maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
    hasMask.value = false
    persistMask(null)
    drawOverlay()
  }

  // Commit the previewed Smart Select segment into the red mask canvas (add), then
  // clear the preview so the next click starts fresh. Undoable like every other
  // mask edit. (The SAM2 side lives in useSmartSelect; committing is here because
  // it is a mask-canvas edit.)
  async function commitSmart() {
    if (!maskOffscreen || !editable.value) return
    // The segment is upsampled to NATIVE resolution by the composable, so the red
    // canvas blits 1:1 into the (native-sized) mask.
    const red = buildCommitCanvas(maskOffscreen.width, maskOffscreen.height)
    if (!red) return
    snapshotForUndo()
    markMaskEdited()
    const ctx = maskOffscreen.getContext('2d')
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(red, 0, 0)
    hasMask.value = true
    discardSmart()
    await exportMask()
  }

  function triggerMaskImport() {
    if (!wholeMaskOk()) return // no canvas to import into yet
    maskFileInput.value?.click()
  }

  // Import an image as mask (the rule — alpha, or black = masked for an opaque file —
  // is core/mask.js normalizeMaskPixels, shared with the Mask Manager).
  async function onMaskFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !maskOffscreen) return
    try {
      // The canvas is already at the mask's storage size, which maps to itself.
      // Decoded on a worker, so a TIFF mask works too.
      const blob = await maskFromFile(file, maskOffscreen.width, maskOffscreen.height)
      // Superseded (undo/stroke/reload while it decoded) → nothing was drawn, so
      // nothing to snapshot or persist.
      if (!(await loadMaskBlob(blob))) return
      snapshotForUndo()
      await exportMask(true) // a blank imported image shouldn't register as a mask
    } catch (err) {
      console.error('Failed to import mask:', err)
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  // Mask-edit shortcuts. Instances are kept alive per tab via v-show, so gate on
  // being the *visible* one and on edit mode. The app-wide key rule
  // (utils/keyRouting.js) decides the rest: no key while a modal dialog is open,
  // typed into a field, or already consumed — and every key acted on here is
  // consumed (preventDefault) so App's global handler skips it. Escape is not
  // handled here: App.vue owns it (it must yield to open modals first, and with
  // none open it leaves mask-edit mode).
  function onKeydown(e) {
    if (!maskEdit() || !wholeMaskOk() || !isVisible()) return
    if (!viewerMayHandleKey(e)) return
    const k = e.key.toLowerCase()
    // A large scan's reduced canvas: no painting tools, only the whole-mask keys.
    if (!editable.value && !(k === 'i' || ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')))) return
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault()
      e.shiftKey ? redoMask() : undoMask()
      return
    }
    if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault()
      redoMask()
      return
    }
    // Smart Select: Enter commits the previewed segment, Del/Backspace discards it.
    if (tool.value === 'smart') {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (smartHasPreview.value) commitSmart()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        discardSmart()
        return
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (k === 'b') tool.value = 'brush'
    else if (k === 'e') tool.value = 'erase'
    else if (k === 'r') tool.value = 'rect'
    else if (k === 's') tool.value = 'smart'
    else if (k === 'i') invertMask()
    else if (e.key === '[') brushRadius.value = Math.max(4, brushRadius.value - 4)
    else if (e.key === ']') brushRadius.value = Math.min(80, brushRadius.value + 4)
    else return
    e.preventDefault()
    drawOverlay()
  }

  // ── Watchers ─────────────────────────────────────────────────────────────────
  // Created in this order, after useImageViewport's url/meta watchers (Vue runs
  // watchers triggered by the same change in creation order; e.g. the uuid watcher
  // must see the frame already cleared by an image switch's url watcher).

  // Smart Select encodes only from the full-resolution image; if the tool was armed
  // while the preview showed, encode once editing unlocks.
  watch(editable, (on) => {
    if (on && maskEdit() && tool.value === 'smart') ensureEncoded()
    drawOverlay()
  })

  // Entering edit mode arms the brush; leaving drops the tool + any in-flight rect
  // and clears any Smart Select candidate.
  watch(maskEdit, (on) => {
    tool.value = on ? 'brush' : null
    if (!on) {
      rectDrag = null
      discardSmart()
      flushMask()
    } // persist the session's edits once
    drawOverlay()
  })
  watch(tool, (t, prev) => {
    rectDrag = null
    if (t === 'smart' && editable.value)
      ensureEncoded() // encode this image (once) so clicks are ready
    else if (prev === 'smart') discardSmart() // dropped Smart Select — clear its preview
    drawOverlay()
  })

  // Switching the viewed image invalidates the SAM2 embedding — reset + free the
  // old one, and re-encode if Smart Select is the active tool.
  watch(
    () => image()?.uuid,
    (uuid, prev) => {
      resetSmart(prev)
      if (maskEdit() && tool.value === 'smart' && editable.value) ensureEncoded()
    },
  )

  // Sync mask canvas when parent clears or replaces the mask externally
  // (and skip the echo of the canvas's own export/undo — it already shows that).
  watch(
    () => image().mask,
    (mask, prev) => {
      if (mask === prev) return
      if (mask?.blob && maskOffscreen) {
        if (mask.blob !== canvasSource) loadMaskBlob(mask.blob)
      } else if (!mask && maskOffscreen) {
        if (canvasSource === null) {
          hasMask.value = false
          return
        }
        markMaskEdited()
        canvasSource = null
        maskOffscreen.getContext('2d').clearRect(0, 0, maskOffscreen.width, maskOffscreen.height)
        hasMask.value = false
        drawOverlay()
      }
    },
  )

  return {
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
    canvas: () => maskOffscreen,
    rect: () => rectDrag,
    isDrawing: () => isDrawing,
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
  }
}
