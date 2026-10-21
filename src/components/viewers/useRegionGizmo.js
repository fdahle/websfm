// The reconstruction region in the 3D view (Viewer3D.vue): its box, and while the
// Region toolbox is open, drag handles that edit the draft (core/products/regionGizmo.js).
// `view` reads the viewer's renderer state live.
import * as THREE from 'three'
import { ref, watch } from 'vue'
import { regionHandles, pickHandle, createRegionDrag } from '../../core/products/regionGizmo.js'
import { disposeObject } from './threeResources.js'

export function useRegionGizmo({ view, props, container, pointerPx, requestRender, emit, otherToolActive }) {
  const raycaster = new THREE.Raycaster()

  // ── Region box ────────────────────────────────────────────────────────────────
  // A wireframe of the reconstruction region (Tools ▸ Model ▾ ▸ Region), in the
  // scene's own (model) coordinates. Drawn on top so it reads through the cloud.
  let regionHelper = null,
    regionHandleObj = null
  function updateRegionBox(b) {
    if (regionHelper) {
      view.scene?.remove(regionHelper)
      disposeObject(regionHelper)
      regionHelper = null
    }
    if (regionHandleObj) {
      view.scene?.remove(regionHandleObj)
      disposeObject(regionHandleObj)
      regionHandleObj = null
    }
    requestRender()
    if (!view.scene || !b?.min || !b?.max) return
    const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max))
    if (box.isEmpty()) return
    regionHelper = new THREE.Box3Helper(box, props.regionStale ? 0x888888 : 0xffb020)
    regionHelper.material.depthTest = false
    regionHelper.material.transparent = true
    regionHelper.material.opacity = props.regionStale ? 0.5 : 0.95
    regionHelper.renderOrder = 11
    view.scene.add(regionHelper)
    if (props.regionEdit) drawRegionHandles(b)
  }
  watch([() => props.regionBox, () => props.regionStale, () => props.regionEdit], ([b]) => updateRegionBox(b), {
    deep: true,
  })

  // Drag handles while the Region toolbox is open (core/products/regionGizmo.js): a
  // square on each face centre moves that face along its axis (red x, green y, blue z),
  // the orange one at the centre moves the box in the plane facing the camera. A drag
  // only edits the draft, like the number fields: Esc during a drag puts the box back,
  // and closing the toolbox without Apply discards the draft.
  const REGION_HANDLE_PX = 9
  const REGION_AXIS_COLOURS = [0xff5555, 0x55dd55, 0x5599ff]
  const regionHover = ref(null) // id of the handle under the pointer, or being dragged
  let regionDrag = null // { drag, start, pointerId }
  function drawRegionHandles(b) {
    const hs = regionHandles(b)
    const pos = new Float32Array(hs.length * 3),
      col = new Float32Array(hs.length * 3)
    const c = new THREE.Color(),
      white = new THREE.Color(0xffffff)
    hs.forEach((h, i) => {
      pos.set(h.pos, i * 3)
      c.setHex(h.axis === null ? 0xffb020 : REGION_AXIS_COLOURS[h.axis])
      if (h.id === regionHover.value) c.lerp(white, 0.6)
      col.set([c.r, c.g, c.b], i * 3)
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
    regionHandleObj = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 2 * REGION_HANDLE_PX - 6,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        transparent: true,
      }),
    )
    regionHandleObj.renderOrder = 12
    regionHandleObj.frustumCulled = false
    view.scene.add(regionHandleObj)
  }
  watch(regionHover, () => updateRegionBox(props.regionBox))

  function regionRay(e) {
    const [px, py] = pointerPx(e)
    const w = container.value.clientWidth,
      h = container.value.clientHeight
    view.camera.updateMatrixWorld()
    raycaster.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, 1 - (py / h) * 2), view.camera)
    const { origin: o, direction: d } = raycaster.ray
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] }
  }
  function regionHandleAt(e) {
    const b = props.regionBox
    if (!props.regionEdit || !b?.min || !b?.max || !view.camera || !container.value) return null
    const [px, py] = pointerPx(e)
    const w = container.value.clientWidth,
      h = container.value.clientHeight
    view.camera.updateMatrixWorld()
    const v = new THREE.Vector3()
    const project = (p) => {
      v.set(p[0], p[1], p[2]).project(view.camera)
      return v.z > 1 || v.z < -1 ? null : [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h]
    }
    return pickHandle(regionHandles(b), project, px, py, REGION_HANDLE_PX)
  }
  // Capture phase, before OrbitControls: a press on a handle drags it, anywhere else orbits.
  function onRegionPointerDown(e) {
    if (!props.regionEdit || e.button !== 0 || !view.renderer || e.target !== view.renderer.domElement || regionDrag)
      return
    if (otherToolActive()) return
    const handle = regionHandleAt(e)
    if (!handle) return
    e.stopPropagation()
    e.preventDefault()
    const start = { min: [...props.regionBox.min], max: [...props.regionBox.max] }
    const forward = new THREE.Vector3()
    view.camera.getWorldDirection(forward)
    const drag = createRegionDrag(start, handle, [forward.x, forward.y, forward.z])
    drag.begin(regionRay(e))
    regionDrag = { drag, start, pointerId: e.pointerId }
    regionHover.value = handle.id
    container.value.setPointerCapture?.(e.pointerId)
  }
  function onRegionPointerMove(e) {
    if (regionDrag) {
      const box = regionDrag.drag.move(regionRay(e))
      if (box) emit('region-change', box)
      return
    }
    // Hover only with no button held (not during an orbit or pan).
    if (props.regionEdit && !e.buttons) regionHover.value = regionHandleAt(e)?.id ?? null
  }
  function onRegionPointerUp(e) {
    if (!regionDrag) return
    regionDrag = null
    container.value?.releasePointerCapture?.(e.pointerId)
    regionHover.value = regionHandleAt(e)?.id ?? null
  }
  watch(
    () => props.regionEdit,
    (on) => {
      if (!on) {
        regionDrag = null
        regionHover.value = null
      }
    },
  )

  // Esc during a drag: the box goes back; the pointerup that follows finds nothing.
  function abortRegionDrag() {
    if (!regionDrag) return false
    const { start, pointerId } = regionDrag
    regionDrag = null
    container.value.releasePointerCapture?.(pointerId)
    emit('region-change', start)
    return true
  }

  return { regionHover, updateRegionBox, onRegionPointerDown, onRegionPointerMove, onRegionPointerUp, abortRegionDrag }
}
