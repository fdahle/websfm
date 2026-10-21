// Measuring in the 3D view (Tools ▸ Measure ▸ Measure in 3D, Viewer3D.vue): points
// picked on the surface, the live result, the overlay and saved 3D measurements.
// `view` reads the viewer's renderer state live; `cloudLayers` is its layer map.
import * as THREE from 'three'
import { ref, computed, watch } from 'vue'
import { useMeasurementsStore } from '../../stores/useMeasurementsStore.js'
import { pickNearestPoint } from '../../core/products/screenPick.js'
import { polyline3d, polygon3d } from '../../core/products/measure.js'
import { cloudUnits, formatMeasure } from '../../core/products/cloudUnits.js'
import { disposeObject } from './threeResources.js'

export function useMeasure3d({
  view, props, container, cloudLayers, sceneUp, pointerPx, pickRadiusPx, requestRender, emit, selectTool, exitSelection,
}) {
  // ── 3D measuring (Tools ▸ Measure ▸ Measure in 3D) ───────────────────────────
  // A click without a drag picks a point ON the surface: a mesh is ray-cast (any point
  // of a triangle, not just its corners), a cloud gives its drawn point nearest the
  // camera. Distance takes two points, a polyline and an area as many as wanted (Enter
  // or a double click finishes, Backspace drops the last, Esc clears then exits).
  // Results are coordinate lengths turned into the project's unit by cloudUnits():
  // metres once a georeference or scale bars exist, otherwise "model units" (or the
  // file's units for an imported layer). Saved results live with the 2D ones
  // (useMeasurementsStore), keeping their points so the numbers follow the unit.
  const measureTool = ref(null)   // null | 'distance' | 'polyline' | 'area'
  const measurePts = ref([])      // [{ pos: [x,y,z], cloudId }]
  const measureDone = ref(false)
  const measureNote = ref('')
  const measurementsStore = useMeasurementsStore()
  const raycaster = new THREE.Raycaster()
  let measureObject = null

  function toggleMeasureTool(kind = 'distance') {
    if (measureTool.value === kind) { exitMeasure(); return }
    if (selectTool.value) exitSelection()
    measureTool.value = kind
    clearMeasure()
  }
  function exitMeasure() { measureTool.value = null; clearMeasure() }
  function clearMeasure() { measurePts.value = []; measureDone.value = false; measureNote.value = ''; drawMeasure() }
  watch(measureTool, (t) => { emit('measure-tool', t); drawMeasure() })
  watch(selectTool, (t) => { if (t && measureTool.value) exitMeasure() })

  const upVector = () => [sceneUp.x, sceneUp.y, sceneUp.z]
  const unitsFor = (cloudId, fallback = null) => {
    const cloud = cloudLayers.get(cloudId)?.source
    return cloud ? cloudUnits(cloud, props.frameSignature) : fallback ?? { scale: 1, unit: 'model', label: 'model units' }
  }

  // The surface point under the pointer: the nearest mesh hit, or the nearest drawn
  // cloud point when that is closer to the camera. → { pos, cloudId } | null
  function surfaceHit(e) {
    const [px, py] = pointerPx(e)
    const w = container.value.clientWidth, h = container.value.clientHeight
    const x = (px / w) * 2 - 1, y = 1 - (py / h) * 2
    view.camera.updateMatrixWorld()
    let best = null
    const meshes = [...cloudLayers.values()].filter((l) => l.object.isMesh && l.object.visible).map((l) => l.object)
    if (meshes.length) {
      raycaster.setFromCamera(new THREE.Vector2(x, y), view.camera)
      const hit = raycaster.intersectObjects(meshes, false)[0]
      if (hit) best = { pos: [hit.point.x, hit.point.y, hit.point.z], cloudId: hit.object.userData.cloudId, dist: hit.distance }
    }
    const viewProj = new THREE.Matrix4().multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse)
    const tolX = (2 * pickRadiusPx) / w, tolY = (2 * pickRadiusPx) / h
    for (const [id, layer] of cloudLayers) {
      if (layer.lod && layer.object.visible) {
        const hit = layer.pick({ viewProj, x, y, tolX, tolY })
        const dist = hit && view.camera.position.distanceTo(new THREE.Vector3(...hit.pos))
        if (hit && (!best || dist < best.dist)) best = { pos: hit.pos, cloudId: id, dist }
        continue
      }
      if (!layer.object.visible || !layer.object.isPoints) continue
      layer.object.updateMatrixWorld()
      const matrix = viewProj.clone().multiply(layer.object.matrixWorld).elements
      const geometry = layer.object.geometry
      const hit = pickNearestPoint(geometry.getAttribute('position').array, layer.count,
        { matrix, x, y, tolX, tolY, indices: geometry.index?.array ?? null })
      if (!hit) continue
      const i = hit.index, src = layer.positions
      const pos = [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]
      const dist = view.camera.position.distanceTo(new THREE.Vector3(...pos))
      if (!best || dist < best.dist) best = { pos, cloudId: id, dist }
    }
    return best && { pos: best.pos, cloudId: best.cloudId }
  }

  function measureClick(e) {
    const hit = surfaceHit(e)
    if (!hit) { measureNote.value = 'Click on a cloud or a mesh'; return }
    if (measureDone.value) { measurePts.value = []; measureDone.value = false }
    const first = measurePts.value[0]
    if (first && !!cloudLayers.get(first.cloudId)?.source?.imported !== !!cloudLayers.get(hit.cloudId)?.source?.imported) {
      measureNote.value = 'Imported and computed layers have different units: measure on one kind'
      return
    }
    measureNote.value = ''
    measurePts.value = [...measurePts.value, hit]
    if (measureTool.value === 'distance' && measurePts.value.length === 2) measureDone.value = true
    drawMeasure()
  }
  function finishMeasure() {
    const need = measureTool.value === 'area' ? 3 : 2
    if (measurePts.value.length >= need) { measureDone.value = true; drawMeasure() }
  }
  function undoMeasure() {
    if (!measurePts.value.length) return
    measurePts.value = measurePts.value.slice(0, -1)
    measureDone.value = false
    drawMeasure()
  }

  // The live result, in the unit of the layer the first point was picked on.
  const measureResult = computed(() => {
    const pts = measurePts.value.map((p) => p.pos)
    if (!measureTool.value || !pts.length) return null
    const units = unitsFor(measurePts.value[0].cloudId)
    return measureTool.value === 'area'
      ? { units, area: polygon3d(pts, upVector()) }
      : { units, line: polyline3d(pts, upVector()) }
  })
  const fmt = (v, units, power = 1) => formatMeasure(v, units, power, power === 1 ? 3 : 2)

  // Saved 3D measurements (kinds length3d / area3d): listed in the toolbox, drawn dim.
  const saved3d = computed(() => measurementsStore.records.filter((r) => r.kind === 'length3d' || r.kind === 'area3d'))
  function savedValue(r) {
    const cloudId = r.source?.startsWith('cloud:') ? r.source.slice(6) : null
    const units = unitsFor(cloudId, r.unitSnapshot)
    if (r.kind === 'area3d') { const a = polygon3d(r.points3d, upVector()); return a ? fmt(a.area, units, 2) : '—' }
    const l = polyline3d(r.points3d, upVector())
    return l ? fmt(l.length, units) : '—'
  }
  function savedStale(r) {
    const cloud = cloudLayers.get(r.source?.slice(6))?.source
    return !cloud || (r.cloudStamp != null && cloud.createdAt !== r.cloudStamp)
  }
  function saveMeasure() {
    const r = measureResult.value
    if (!r || !measureDone.value) return
    const first = measurePts.value[0], cloud = cloudLayers.get(first.cloudId)?.source
    const kind = measureTool.value === 'area' ? 'area3d' : 'length3d'
    const n = saved3d.value.filter((x) => x.kind === kind).length + 1
    measurementsStore.add({
      name: `${kind === 'area3d' ? 'Area' : measureTool.value === 'distance' ? 'Distance' : 'Polyline'} ${n} (3D)`,
      kind, source: `cloud:${first.cloudId}`, cloudName: cloud?.name ?? null, cloudStamp: cloud?.createdAt ?? null,
      vertices: [], points3d: measurePts.value.map((p) => p.pos), unitSnapshot: r.units,
      // The scene's up at the time: the export splits lengths along it, as the toolbox did.
      up: upVector(),
    })
  }

  // The overlay: the current outline bright, saved ones dim; on top of the scene.
  function drawMeasure() {
    if (measureObject) { view.scene?.remove(measureObject); disposeObject(measureObject); measureObject = null }
    requestRender()
    if (!view.scene || !measureTool.value) return
    const group = new THREE.Group()
    const add = (pts, closed, colour, opacity, dots) => {
      if (!pts.length) return
      const o = pts[0]
      const rel = new Float32Array(pts.length * 3)
      pts.forEach((p, k) => { rel[k * 3] = p[0] - o[0]; rel[k * 3 + 1] = p[1] - o[1]; rel[k * 3 + 2] = p[2] - o[2] })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(rel, 3))
      const lineMat = new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity })
      const line = closed && pts.length > 2 ? new THREE.LineLoop(geometry, lineMat) : new THREE.Line(geometry, lineMat)
      line.position.set(o[0], o[1], o[2]); line.renderOrder = 13
      group.add(line)
      if (dots) {
        const pm = new THREE.PointsMaterial({ color: colour, size: 9, sizeAttenuation: false, depthTest: false, transparent: true, opacity })
        const points = new THREE.Points(geometry.clone(), pm)
        points.position.set(o[0], o[1], o[2]); points.renderOrder = 14
        group.add(points)
      }
    }
    for (const r of saved3d.value) add(r.points3d, r.kind === 'area3d', '#7fb7ff', 0.55, false)
    add(measurePts.value.map((p) => p.pos), measureTool.value === 'area' && measureDone.value, '#ffcc33', 1, true)
    measureObject = group
    view.scene.add(group)
  }
  watch(saved3d, drawMeasure)

  return {
    measureTool, measurePts, measureDone, measureNote, measureResult, saved3d, measurementsStore, fmt,
    toggleMeasureTool, exitMeasure, clearMeasure, measureClick, finishMeasure, undoMeasure,
    savedValue, savedStale, saveMeasure, drawMeasure,
  }
}
