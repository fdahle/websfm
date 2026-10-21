// Rectangle / lasso selection of dense-cloud points in the 3D view (Viewer3D.vue),
// and what is done with a selection (delete, keep only, assign a class). `view` reads
// the viewer's renderer state live; `cloudLayers` is its layer map.
import * as THREE from 'three'
import { ref, watch } from 'vue'
import { useViewerSettings } from '../../composables/useViewerSettings.js'
import { resolveCloudStyle } from '../../core/products/cloudStyle.js'
import { screenSelectMask, maskIndices } from '../../core/products/screenSelect.js'
import { disposeObject } from './threeResources.js'

export function useCloudSelection({ view, container, cloudLayers, pointerPx, requestRender, emit, onEditPending }) {
  const { pointSize } = useViewerSettings()

  // ── Point selection (rectangle / lasso) ──────────────────────────────────────
  // Left-drag draws a shape while a tool is active; orbit/pan/zoom keep working on
  // the other buttons and the wheel. Only dense clouds are selectable — a sparse
  // cloud's points carry view-tracks (see core/products/cloudEdit.js), and a mesh's
  // vertices are not points. The mask is computed over the exact Float32 buffer and
  // matrix being drawn (core/products/screenSelect.js), so the highlight IS the
  // selection. Selection is not reactive state: per-layer masks live here, keyed by
  // cloud id and stamped with the source buffer, and are dropped whenever that
  // layer's geometry is rebuilt.
  const selectTool = ref(null) // null | 'rect' | 'lasso'
  const selectionCount = ref(0)
  const selectionStreamed = ref(false) // a streamed cloud's count is of the points drawn now
  const selectionClouds = ref(0)
  const drawShape = ref(null) // { kind, points:[x,y,…] } in container px, for the SVG
  const selections = new Map() // cloudId → { mask, selected, pos, overlay }
  let drawing = null // { op, startX, startY, pts }

  // A streamed cloud (no points in memory) is selectable through its octree layer: its
  // selection is the shapes drawn, replayed on every point by the edit.
  const streamedLayer = (l) => !!l.lod && !l.source.pos
  function selectableLayers() {
    return [...cloudLayers].filter(
      ([, l]) => l.source.kind === 'dense' && (l.object.isPoints || streamedLayer(l)) && l.object.visible,
    )
  }
  // The classes a classification style hides: a shape drawn then cannot select them.
  function hiddenClasses(cloud) {
    const style = resolveCloudStyle(cloud)
    if (style.field !== 'attribute:classification') return []
    return Object.entries(style.classes ?? {})
      .filter(([, c]) => c?.visible === false)
      .map(([v]) => Number(v))
  }
  function lodSelectionOverlay(layer, entry, pos) {
    disposeSelectionOverlay(entry)
    if (!entry.selected) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const material = new THREE.PointsMaterial({
      color: 0xff3d71,
      size: pointSize.value + 1,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    })
    const overlay = new THREE.Points(geometry, material)
    overlay.position.copy(layer.object.position)
    overlay.renderOrder = 10
    view.scene.add(overlay)
    entry.overlay = overlay
  }

  function disposeSelectionOverlay(entry) {
    if (!entry?.overlay) return
    view.scene?.remove(entry.overlay)
    disposeObject(entry.overlay)
    entry.overlay = null
  }

  function refreshSelectionSummary() {
    let total = 0,
      clouds = 0
    for (const e of selections.values())
      if (e.selected) {
        total += e.selected
        clouds++
      }
    selectionCount.value = total
    selectionStreamed.value = [...selections.values()].some((e) => e.ops)
    selectionClouds.value = clouds
    requestRender() // every selection change adds, rebuilds or drops an overlay
  }

  // Highlight: a compact copy of only the selected positions, drawn on top without
  // depth testing, so points selected *behind* a surface show too — they will be
  // deleted along with the visible ones, and the user should see that. Not a shared
  // position attribute: disposing a geometry frees its attributes' GL buffers, which
  // would force a re-upload of the whole cloud.
  function buildSelectionOverlay(layer, entry) {
    disposeSelectionOverlay(entry)
    if (!entry.selected) return
    const src = layer.object.geometry.getAttribute('position').array
    const idx = maskIndices(entry.mask, entry.selected)
    const pos = new Float32Array(idx.length * 3)
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k] * 3
      pos[k * 3] = src[i]
      pos[k * 3 + 1] = src[i + 1]
      pos[k * 3 + 2] = src[i + 2]
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const material = new THREE.PointsMaterial({
      color: 0xff3d71,
      size: pointSize.value + 1,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    })
    const overlay = new THREE.Points(geometry, material)
    overlay.position.copy(layer.object.position)
    overlay.renderOrder = 10
    view.scene.add(overlay)
    entry.overlay = overlay
  }

  function clearSelection() {
    for (const e of selections.values()) disposeSelectionOverlay(e)
    selections.clear()
    refreshSelectionSummary()
  }

  // Drop selections whose layer was removed or rebuilt (new buffer ⇒ stale mask).
  function pruneSelections() {
    for (const [id, e] of selections) {
      const layer = cloudLayers.get(id)
      // A restyle that hides classes swaps the index buffer: a point selected while
      // drawn may now be hidden, and must not be deleted unseen.
      const stale = e.ops
        ? !layer || layer.source.lod !== e.lod || !layer.object.visible
        : !layer ||
          layer.source.pos !== e.pos ||
          !layer.object.visible ||
          (layer.object.geometry.index ?? null) !== e.index
      if (stale) {
        disposeSelectionOverlay(e)
        selections.delete(id)
      }
    }
    refreshSelectionSummary()
  }

  // Driven by the ribbon (View ▸ Select): choosing the active tool again leaves it.
  function toggleSelectTool(kind) {
    selectTool.value = selectTool.value === kind ? null : kind
  }
  // The toolbox's ×: drop the selection and leave the tool in one step.
  function exitSelection() {
    clearSelection()
    selectTool.value = null
  }
  watch(selectTool, (t) => emit('select-tool', t))

  // Capture-phase on the container: runs before OrbitControls' own pointerdown on
  // the canvas, so a left-drag with a tool active never starts an orbit.
  function onSelectPointerDown(e) {
    if (!selectTool.value || e.button !== 0 || !view.renderer || e.target !== view.renderer.domElement) return
    if (drawing) return // a second pointer must not hijack the stroke in progress
    e.stopPropagation()
    e.preventDefault()
    const [x, y] = pointerPx(e)
    drawing = {
      op: e.shiftKey ? 'add' : e.altKey || e.ctrlKey || e.metaKey ? 'subtract' : 'replace',
      startX: x,
      startY: y,
      pts: [x, y],
    }
    container.value.setPointerCapture?.(e.pointerId)
    drawShape.value = { kind: selectTool.value, points: [x, y, x, y] }
  }

  function onSelectPointerMove(e) {
    if (!drawing) return
    const [x, y] = pointerPx(e)
    if (selectTool.value === 'rect') {
      drawShape.value = { kind: 'rect', points: [drawing.startX, drawing.startY, x, y] }
    } else {
      const n = drawing.pts.length
      if (Math.hypot(x - drawing.pts[n - 2], y - drawing.pts[n - 1]) >= 3) drawing.pts.push(x, y)
      drawShape.value = { kind: 'lasso', points: drawing.pts.slice() }
    }
  }

  function onSelectPointerUp(e) {
    if (!drawing) return
    const shapePx = drawShape.value
    const op = drawing.op
    drawing = null
    drawShape.value = null
    container.value.releasePointerCapture?.(e.pointerId)
    if (!shapePx || !view.camera) return
    const w = container.value.clientWidth,
      h = container.value.clientHeight
    const ndc = shapePx.points.map((v, i) => (i % 2 === 0 ? (v / w) * 2 - 1 : 1 - (v / h) * 2))
    const shape =
      shapePx.kind === 'rect'
        ? { kind: 'rect', x0: ndc[0], y0: ndc[1], x1: ndc[2], y1: ndc[3] }
        : { kind: 'lasso', points: ndc }
    applySelectionShape(shape, op)
  }

  function applySelectionShape(shape, op) {
    view.camera.updateMatrixWorld()
    const viewProj = new THREE.Matrix4().multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse)
    const layers = selectableLayers()
    const ids = new Set(layers.map(([id]) => id))
    if (op === 'replace') {
      for (const [id, e] of selections)
        if (!ids.has(id)) {
          disposeSelectionOverlay(e)
          selections.delete(id)
        }
    }
    for (const [id, layer] of layers) {
      layer.object.updateMatrixWorld()
      const matrix = viewProj.clone().multiply(layer.object.matrixWorld).elements
      if (streamedLayer(layer)) {
        const prev = selections.get(id)
        const ops = [
          ...(op !== 'replace' && prev?.ops ? prev.ops : []),
          { shape, matrix: [...matrix], op, hidden: hiddenClasses(layer.source) },
        ]
        const { selected, pos } = layer.selectDrawn(ops)
        const entry = prev ?? { overlay: null }
        Object.assign(entry, { ops, selected, lod: layer.source.lod })
        // Kept while the shapes may select points not drawn now; dropped when nothing is.
        if (selected || ops.some((o) => o.op !== 'subtract')) {
          selections.set(id, entry)
          lodSelectionOverlay(layer, entry, pos)
        } else {
          disposeSelectionOverlay(entry)
          selections.delete(id)
        }
        continue
      }
      const geometry = layer.object.geometry
      const prev = selections.get(id)
      const base = prev && prev.pos === layer.source.pos ? prev.mask : null
      const { mask, selected } = screenSelectMask(geometry.getAttribute('position').array, layer.count, {
        matrix,
        shape,
        indices: geometry.index?.array ?? null,
        base,
        op,
      })
      const entry = prev ?? { overlay: null }
      Object.assign(entry, { mask, selected, pos: layer.source.pos, index: geometry.index ?? null })
      if (selected) {
        selections.set(id, entry)
        buildSelectionOverlay(layer, entry)
      } else {
        disposeSelectionOverlay(entry)
        selections.delete(id)
      }
    }
    refreshSelectionSummary()
  }

  // Hand the masks to App (and on to the store). The masks are transferred to the
  // worker there, so the local selection is cleared immediately.
  function commitSelection(keepSelected, classValue = null) {
    const edits = [...selections]
      .filter(([, e]) => e.selected || e.ops)
      .map(([cloudId, e]) => (e.ops ? { cloudId, selection: e.ops } : { cloudId, mask: e.mask }))
    if (!edits.length) return
    clearSelection()
    onEditPending(new Set(edits.map((e) => e.cloudId)))
    emit('edit-selection', { edits, keepSelected, classValue })
  }
  // Manual reclassification: the LAS classes offered for a selection (TODO ▸ F14).
  const ASSIGN_CLASSES = [
    [2, 'Ground'],
    [1, 'Unclassified'],
    [3, 'Low vegetation'],
    [4, 'Medium vegetation'],
    [5, 'High vegetation'],
    [6, 'Building'],
    [9, 'Water'],
    [7, 'Low noise'],
    [18, 'High noise'],
  ]
  const assignClass = ref(2)

  // Esc during a stroke: drop it; the pointerup that follows finds nothing.
  function abortStroke() {
    if (!drawing) return false
    drawing = null
    drawShape.value = null
    return true
  }

  // The ribbon's point size, on the highlight overlays too.
  function setOverlaySize(size) {
    for (const e of selections.values()) if (e.overlay) e.overlay.material.size = size + 1
  }

  return {
    selectTool,
    selectionCount,
    selectionStreamed,
    selectionClouds,
    drawShape,
    assignClass,
    ASSIGN_CLASSES,
    selectableLayers,
    toggleSelectTool,
    exitSelection,
    clearSelection,
    pruneSelections,
    commitSelection,
    onSelectPointerDown,
    onSelectPointerMove,
    onSelectPointerUp,
    abortStroke,
    setOverlaySize,
    applySelectionShape,
  }
}
