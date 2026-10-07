<script setup>
import { relativePositions } from '../../core/products/pointView.ts'
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { useViewerSettings } from '../../composables/useViewerSettings.js'
import { estimateUpFromCameras } from '../../core/sfm/geometry.js'
import CloudLegend from './CloudLegend.vue'
import FloatingToolbox from './FloatingToolbox.vue'
import { buildCloudStyle, scalarRange, sharedElevationRange, resolveCloudStyle } from '../../core/products/cloudStyle.js'
import { viewerClipping } from '../../core/products/viewerClipping.js'
import { screenSelectMask, maskIndices } from '../../core/products/screenSelect.js'
import { pickNearestPoint } from '../../core/products/screenPick.js'

// pointSize / cameraScale are set from the ribbon's View ▸ Scene steppers.
const { gridZ, background, nearClip, pointSize, cameraScale } = useViewerSettings()

const props = defineProps({
  theme: { type: String, default: 'dark' },
  showLegend: { type: Boolean, default: false },
  // Source images ({ uuid, url, … }) — used to texture camera-frustum thumbnails.
  images: { type: Array, default: () => [] },
  showCameras: { type: Boolean, default: true },
  showGrid: { type: Boolean, default: true },
  // Estimated scene "up" (unit [x,y,z]) from the reconstruction's camera poses, so a
  // dense/mesh cloud — which carries no cameras of its own — still frames level (see
  // estimateUpFromCameras). null ⇒ fall back to the viewer's own cameras, else +Z.
  sceneUp: { type: Array, default: null },
  // The reconstruction region box to draw ({ min, max } in model coordinates) —
  // the live draft while the Region toolbox is open, else the saved region. null ⇒ none.
  regionBox: { type: Object, default: null },
  // Drawn dashed and dim when the saved region no longer matches the model.
  regionStale: { type: Boolean, default: false },
  // Point picking for a running tool (point-pair alignment, orient model):
  // { cloudIds?: string[] } restricts which clouds a click can pick. null ⇒ off.
  pickMode: { type: Object, default: null },
  // Points a tool wants shown on top: [{ position: [x,y,z], color: '#rrggbb' }].
  markers: { type: Array, default: () => [] },
})
// Emits ribbon command ids so App's handleCommand routes them (toggles live in App).
// `edit-selection` carries { edits: [{ cloudId, mask }], keepSelected } for App to
// apply through the store's non-destructive cloud-edit path. `select-tool` reports
// the active selection tool (null | 'rect' | 'lasso') so the ribbon's View ▸ Select
// toggles can show it — the same up-reporting raster measuring uses.
const emit = defineEmits(['command', 'edit-selection', 'select-tool', 'pick'])

const container = ref(null)
// Set when WebGL is unavailable (headless/sandboxed/GPU-disabled). We degrade to an
// overlay instead of throwing out of the mounted hook, which would crash app mount and
// take the whole UI down with the 3D view.
const glError = ref('')
let renderer, scene, camera, controls, animationId, resizeObserver, grid

// ── Frustum sizing helpers ────────────────────────────────────────────────────
// The visual size of the camera frustums / image thumbnails is driven by how
// tightly the cameras were shot (median nearest-neighbour spacing), NOT by the
// point-cloud extent. Point-cloud radius is a poor proxy: a small/compact sparse
// cloud — or one whose radius is inflated by a few stray triangulated points —
// makes every quad the same big size regardless of camera spacing, so they pile
// up and overlap. Nearest-neighbour spacing is invariant to those outliers and to
// absolute scene scale, so adjacent frustums roughly touch instead of overlapping.
function median(arr) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])
}
function percentile(arr, q) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))
  return s[idx]
}
// centres: THREE.Vector3[] of camera centres. Returns the frustum forward depth.
function cameraFrustumDepth(centres, points3d) {
  // Preferred: median nearest-neighbour distance between camera centres.
  if (centres.length >= 2) {
    const nn = []
    for (let i = 0; i < centres.length; i++) {
      let best = Infinity
      for (let j = 0; j < centres.length; j++) {
        if (i === j) continue
        const d = centres[i].distanceTo(centres[j])
        if (d < best) best = d
      }
      if (best < Infinity) nn.push(best)
    }
    const med = median(nn)
    if (med > 0) return med * 0.6  // adjacent quads (half-width 0.3·d) stay clear
  }
  // Fallback (<2 cameras): robust point radius about the centroid — 95th
  // percentile so a handful of outlier points can't blow up the scale.
  if (points3d.length > 0) {
    let mx = 0, my = 0, mz = 0
    for (const p of points3d) { mx += p.x; my += p.y; mz += p.z }
    mx /= points3d.length; my /= points3d.length; mz /= points3d.length
    const r = percentile(points3d.map((p) => Math.hypot(p.x - mx, p.y - my, p.z - mz)), 0.95)
    if (r > 0) return r * 0.15
  }
  return 0.15
}

// Robust scene bounds from a flat position buffer: a per-axis *median* centre and a
// 95th-percentile radius, so a handful of stray far points (common in sparse clouds)
// can't inflate the framing or the grid span — the raw Three.js bounding sphere
// (Ritter) is outlier-sensitive and made sparse↔dense frame very differently. Also
// returns the 2nd/98th-percentile extent *along `up`* for grid placement. Sub-
// samples to ≤ SAMPLE points so million-point dense clouds stay cheap on the main
// thread.
const BOUNDS_SAMPLE = 20000
function robustBounds(positions, count, up) {
  const step = Math.max(1, Math.floor(count / BOUNDS_SAMPLE))
  const xs = [], ys = [], zs = []
  for (let i = 0; i < count; i += step) {
    xs.push(positions[i * 3]); ys.push(positions[i * 3 + 1]); zs.push(positions[i * 3 + 2])
  }
  const cx = median(xs), cy = median(ys), cz = median(zs)
  const dists = [], alongs = []
  for (let k = 0; k < xs.length; k++) {
    const dx = xs[k] - cx, dy = ys[k] - cy, dz = zs[k] - cz
    dists.push(Math.hypot(dx, dy, dz))
    alongs.push(dx * up.x + dy * up.y + dz * up.z)
  }
  return {
    center: new THREE.Vector3(cx, cy, cz),
    radius: percentile(dists, 0.95) || 1,
    alongMin: percentile(alongs, 0.02),
    alongMax: percentile(alongs, 0.98),
  }
}

// Independent cloud layers and shared camera frustums
const cloudLayers = new Map()
const legendLayers = ref([])
const linearChannel = Float32Array.from({ length: 256 }, (_, i) =>
  new THREE.Color().setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r)
let lastCameraMaps = []
let knownCloudIds = new Set()
// Set when a selection edit is committed: the cloud it adds (a derived fork of a
// computed/imported source) replaces the one the user was zoomed into, so it must
// not re-frame the scene the way a newly imported cloud does.
let keepViewForEdit = false
// Imported point buffers are immutable; replacing a buffer invalidates its range.
const elevationRanges = new WeakMap()
function cachedElevationRange(cloud) {
  const data = cloud.pos || cloud.points
  const count = cloud.nVerts ?? cloud.count ?? cloud.points?.length ?? 0
  let cached = elevationRanges.get(data)
  if (!cached || cached.count !== count) {
    cached = { count, range: scalarRange(cloud, 'elevation') }
    elevationRanges.set(data, cached)
  }
  return cached.range
}
const frustumGroup = new THREE.Group()
// Camera glyphs are shared unit geometry placed by a per-camera matrix, so a
// cameraScale step only rewrites matrices. Thumbnails are small (THUMB_PX²)
// textures cached by image across rebuilds: re-decoding every full-resolution
// photo and uploading it to the GPU on each size step or sparse-cloud toggle was
// the lag. An entry is dropped only when its image is removed or its url changes.
const THUMB_PX = 256
const THUMB_DECODES = 4 // concurrent full-size decodes (each is w·h·4 bytes)
const thumbCache = new Map() // uuid → { url, tex, mat }
const thumbQueue = []
let thumbActive = 0
let frustumLineMat = null, frustumLineGeo = null, frustumPlaneGeo = null

function disposeMaterial(material, textures = new Set(), materials = new Set()) {
  for (const mat of Array.isArray(material) ? material : [material]) {
    if (!mat || materials.has(mat)) continue
    materials.add(mat)
    for (const value of Object.values(mat)) {
      if (value?.isTexture && !textures.has(value)) {
        textures.add(value); value.dispose()
      }
    }
    mat.dispose()
  }
}

function disposeObject(root) {
  const textures = new Set()
  const materials = new Set()
  root?.traverse((obj) => {
    obj.geometry?.dispose()
    if (obj.material) disposeMaterial(obj.material, textures, materials)
  })
}

// Removes the glyphs only; geometry, materials and thumbnails are shared/cached.
function clearFrustums() {
  frustumGroup.clear()
}

function disposeThumb(entry) {
  entry.disposed = true
  entry.mat.dispose()
  entry.tex.image?.close?.()
  entry.tex.dispose()
}

function disposeFrustumResources() {
  clearFrustums()
  for (const entry of thumbCache.values()) disposeThumb(entry)
  thumbCache.clear()
  thumbQueue.length = 0
  frustumLineMat?.dispose(); frustumLineGeo?.dispose(); frustumPlaneGeo?.dispose()
  frustumLineMat = frustumLineGeo = frustumPlaneGeo = null
}

function pumpThumbQueue() {
  while (thumbActive < THUMB_DECODES && thumbQueue.length) {
    const entry = thumbQueue.shift()
    if (entry.disposed) continue
    thumbActive++
    // createImageBitmap decodes off the main thread and resizes in one step.
    // The bitmap is flipped here because WebGL ignores UNPACK_FLIP_Y for it.
    fetch(entry.url)
      .then(r => r.blob())
      .then(blob => createImageBitmap(blob, {
        resizeWidth: THUMB_PX, resizeHeight: THUMB_PX, resizeQuality: 'medium', imageOrientation: 'flipY',
      }))
      .then((bitmap) => {
        if (entry.disposed) { bitmap.close(); return }
        entry.tex.image = bitmap
        entry.tex.needsUpdate = true
      })
      .catch(() => {}) // a dead blob: url just leaves the quad untextured
      .finally(() => { thumbActive--; pumpThumbQueue() })
  }
}

function thumbFor(uuid, url) {
  let entry = thumbCache.get(uuid)
  if (entry?.url === url) return entry
  if (entry) disposeThumb(entry)
  const tex = new THREE.Texture()
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  entry = { url, tex, mat: new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }), disposed: false }
  thumbCache.set(uuid, entry)
  thumbQueue.push(entry)
  pumpThumbQueue()
  return entry
}

function ensureFrustumGeometry() {
  if (frustumLineGeo) return
  frustumLineMat = new THREE.LineBasicMaterial({ color: 0xff8844 })
  // Unit frustum in camera space (x right, y down, +z forward), depth 1.
  // corners = [BL-in-image, BR, TR, TL]; 4 centre→corner edges + the far face.
  const h = 0.5
  const c = [[-h, -h, 1], [h, -h, 1], [h, h, 1], [-h, h, 1]]
  const lines = []
  for (const p of c) lines.push(0, 0, 0, ...p)
  for (let i = 0; i < 4; i++) lines.push(...c[i], ...c[(i + 1) % 4])
  frustumLineGeo = new THREE.BufferGeometry()
  frustumLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3))
  frustumLineGeo.computeBoundingSphere()
  // Thumbnail quad on the far face. The bitmap is pre-flipped (row 0 at v=1),
  // so the image's top row maps to the y=-h corners.
  frustumPlaneGeo = new THREE.BufferGeometry()
  frustumPlaneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c.flat()), 3))
  frustumPlaneGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2))
  frustumPlaneGeo.setIndex([0, 1, 2, 0, 2, 3])
  frustumPlaneGeo.computeBoundingSphere()
}

// world = Rᵀ·(s·local) + C — camera-to-world, uniformly scaled by the frustum depth.
function placeFrustum(obj, depth) {
  const { R, centre: C } = obj.userData
  obj.matrix.set(
    R[0][0] * depth, R[1][0] * depth, R[2][0] * depth, C.x,
    R[0][1] * depth, R[1][1] * depth, R[2][1] * depth, C.y,
    R[0][2] * depth, R[1][2] * depth, R[2][2] * depth, C.z,
    0, 0, 0, 1,
  )
  obj.matrixWorldNeedsUpdate = true
}

function scaleFrustums(depth) {
  for (const obj of frustumGroup.children) placeFrustum(obj, depth)
}

// Robust bounds of the loaded scene — drive the camera view presets and grid.
const sceneCenter = new THREE.Vector3(0, 0, 0)
let sceneRadius = 5
// Estimated scene up (unit); orients the initial view + grid so the model reads
// level without georeferencing (see estimateUpFromCameras). Default world +Z.
const sceneUp = new THREE.Vector3(0, 0, 1)
// Signed extent of the cloud/mesh *along sceneUp*, relative to sceneCenter — drives
// the grid's min/avg/max placement (see updateGrid). 0 until a cloud loads.
let sceneAlongMin = 0, sceneAlongMax = 0

// Cached frustum inputs so a cameraScale change can rebuild frustums cheaply
// without recomputing the whole cloud.
let lastCams = []
let lastBaseDepth = 0.15

const BG = { dark: 0x1a1a1a, light: 0xf0f0f0, black: 0x000000 }
function backgroundColor() {
  const key = background.value === 'theme' ? props.theme : background.value
  return BG[key] ?? BG.dark
}
const GRID = {
  dark:  [0x444444, 0x2a2a2a],
  light: [0xb8b8b8, 0xd8d8d8],
}

function makeGrid(t) {
  const [mc, gc] = GRID[t] ?? GRID.dark
  const g = new THREE.GridHelper(10, 10, mc, gc)
  // Reference lines should not write competing depths into a coplanar cloud.
  g.material.depthWrite = false
  // GridHelper lies in the XZ plane (normal +Y). updateGrid orients it so its normal
  // matches the estimated scene up (world +Z by default).
  g.visible = props.showGrid
  return g
}

const GRID_NORMAL = new THREE.Vector3(0, 1, 0) // GridHelper's default plane normal

// Sit the grid under the loaded scene (centred on the cloud, spanning its
// extent, its plane perpendicular to the estimated up) rather than at the world
// origin — which is usually where the camera cluster sits, leaving the grid stranded
// away from the points. Its placement along up follows the gridZ setting.
function updateGrid() {
  if (!grid) return
  const span = Math.max(sceneRadius * 2, 1)
  grid.scale.setScalar(span / 10) // GridHelper(10,…) is 10 world units wide by default
  grid.quaternion.setFromUnitVectors(GRID_NORMAL, sceneUp) // lay it perpendicular to up
  const off = gridZ.value === 'min' ? sceneAlongMin
            : gridZ.value === 'max' ? sceneAlongMax
            : 0.5 * (sceneAlongMin + sceneAlongMax) // 'avg' → middle of the extent
  grid.position.copy(sceneCenter).addScaledVector(sceneUp, off)
}

function init() {
  const el = container.value
  const w = el.clientWidth, h = el.clientHeight

  // Create the WebGL renderer FIRST: if the context can't be created (sandboxed /
  // GPU-disabled / headless), the constructor throws — catch it and bail before any
  // scene/camera/controls exist, so every `if (!scene)` guard below and in the watchers
  // keeps the component inert rather than half-initialised.
  try {
    // Survey extents and close-up inspection span many orders of magnitude.
    // Log depth avoids the poor far-surface precision of a tiny near plane.
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
  } catch (e) {
    glError.value = 'The 3D view is unavailable: this browser or environment could not '
      + 'create a WebGL context. The rest of the app is unaffected.'
    console.warn('[Viewer3D] WebGL unavailable — 3D view disabled:', e)
    return
  }
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(backgroundColor())

  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 10000)
  // Z-up scene (elevation along +Z, matching the SfM/geospatial convention).
  camera.up.set(0, 0, 1)
  camera.position.set(3, -3, 2.5)
  camera.lookAt(0, 0, 0)

  grid = makeGrid(props.theme)
  updateGrid() // orient the (empty) grid to the default up before any cloud loads
  scene.add(grid)
  frustumGroup.visible = props.showCameras
  scene.add(frustumGroup)

  const dir = new THREE.DirectionalLight(0xffffff, 2)
  dir.position.set(5, 10, 7)
  scene.add(dir)
  scene.add(new THREE.AmbientLight(0xffffff, 0.4))
  updateRegionBox(props.regionBox)
  updateMarkers(props.markers)

  controls = makeControls()

  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(el)

  animate()
}

// ── Reconstruction visualisation ─────────────────────────────────────────────

function createCloudLayer(cloud) {
  const isMesh = cloud.kind === 'mesh'
  const count = isMesh ? cloud.nVerts : (cloud.count ?? cloud.points?.length ?? 0)
  if (!count) return null
  let positions = cloud.pos
  if (!positions) {
    positions = new Float64Array(count * 3)
    for (let i = 0; i < count; i++) {
      const p = cloud.points[i]
      positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z
    }
  }
  const geometry = new THREE.BufferGeometry()
  const { origin, relative } = relativePositions(positions)
  geometry.setAttribute('position', new THREE.BufferAttribute(relative, 3))
  if (isMesh) {
    geometry.setIndex(new THREE.BufferAttribute(cloud.idx, 1))
    geometry.computeVertexNormals()
  }
  geometry.computeBoundingSphere()
  const material = isMesh
    ? new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.95, metalness: 0 })
    : new THREE.PointsMaterial({ size: pointSize.value, sizeAttenuation: false })
  const object = isMesh ? new THREE.Mesh(geometry, material) : new THREE.Points(geometry, material)
  object.position.set(...origin)
  object.userData.cloudId = cloud.id
  scene.add(object)
  return { object, positions, count, source: cloud, bounds: robustBounds(positions, count, sceneUp) }
}

function styleLayer(layer, cloud, elevationRange) {
  const visual = buildCloudStyle(cloud, undefined, { elevationRange })
  const { geometry, material } = layer.object
  // Release replaced colour/index GPU buffers before uploading a new style.
  // The geometry's CPU position array remains available for the next upload.
  if (layer.legend) geometry.dispose()
  if (visual.colors) {
    // Three.js shades vertex colours in linear space; source RGB, ramp colours
    // and legend swatches are sRGB. Convert so the displayed legend matches.
    const colors = new Float32Array(visual.colors.length)
    for (let i = 0; i < colors.length; i++) colors[i] = linearChannel[visual.colors[i]]
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  } else geometry.deleteAttribute('color')
  if (cloud.kind !== 'mesh') geometry.setIndex(visual.indices ? new THREE.BufferAttribute(visual.indices, 1) : null)
  material.vertexColors = !!visual.colors
  material.color.set(visual.colors ? 0xffffff : visual.style.colour)
  material.opacity = visual.style.opacity
  material.transparent = visual.style.opacity < 1
  material.depthWrite = visual.style.opacity === 1
  material.needsUpdate = true
  layer.style = cloud.style
  layer.legend = visual.legend
  layer.elevationRangeKey = elevationRange ? `${elevationRange.min}:${elevationRange.max}` : ''
}

function updateLayerBounds() {
  if (!cloudLayers.size) {
    sceneCenter.set(0, 0, 0); sceneRadius = 5
    sceneAlongMin = 0; sceneAlongMax = 0
    return
  }
  const box = new THREE.Box3()
  let low = Infinity, high = -Infinity
  for (const { bounds: b } of cloudLayers.values()) {
    box.expandByPoint(b.center.clone().addScalar(-b.radius))
    box.expandByPoint(b.center.clone().addScalar(b.radius))
    const height = b.center.dot(sceneUp)
    low = Math.min(low, height + b.alongMin)
    high = Math.max(high, height + b.alongMax)
  }
  box.getCenter(sceneCenter)
  sceneRadius = Math.max(0.001, box.getSize(new THREE.Vector3()).length() / 2)
  sceneAlongMin = low - sceneCenter.dot(sceneUp)
  sceneAlongMax = high - sceneCenter.dot(sceneUp)
}

// Reconcile by cloud id, retaining GPU geometry when only selection, names,
// symbology or another layer changes. Each origin is placed in the same world
// frame, so projected survey coordinates stay aligned across multiple files.
function setCloudLayers(clouds) {
  if (!scene) return
  const hadContent = cloudLayers.size > 0 || frustumGroup.children.length > 0
  const addedCloud = clouds.some(c => c.visible !== false && !knownCloudIds.has(c.id))
  knownCloudIds = new Set(clouds.map(c => c.id))
  const visible = clouds.filter(c => c.visible !== false)
  const elevationRange = sharedElevationRange(clouds, cachedElevationRange)
  const ids = new Set(visible.map(c => c.id))
  for (const [id, layer] of cloudLayers) {
    if (!ids.has(id)) { scene.remove(layer.object); disposeObject(layer.object); cloudLayers.delete(id) }
  }
  const cameraMaps = visible.map(c => c.cameras).filter(Boolean)
  const camerasChanged = cameraMaps.length !== lastCameraMaps.length || cameraMaps.some((m, i) => m !== lastCameraMaps[i])
  const cameras = new Map()
  for (const map of cameraMaps) for (const [id, cam] of map) cameras.set(id, cam)
  const up = props.sceneUp || estimateUpFromCameras(cameras)
  if (up) sceneUp.set(...up).normalize()
  else sceneUp.set(0, 0, 1)
  for (const cloud of visible) {
    let layer = cloudLayers.get(cloud.id)
    if (layer && (layer.source.pos !== cloud.pos || layer.source.points !== cloud.points || layer.source.idx !== cloud.idx
        || layer.source.count !== cloud.count || layer.source.kind !== cloud.kind)) {
      scene.remove(layer.object); disposeObject(layer.object); cloudLayers.delete(cloud.id); layer = null
    }
    if (!layer) {
      layer = createCloudLayer(cloud)
      if (!layer) continue
      cloudLayers.set(cloud.id, layer)
    }
    const style = resolveCloudStyle(cloud)
    const sharedRange = style.field === 'elevation' && style.range === 'auto' ? elevationRange : null
    const rangeKey = sharedRange ? `${sharedRange.min}:${sharedRange.max}` : ''
    if (!layer.legend || layer.style !== cloud.style || layer.source.col !== cloud.col || layer.source.attributes !== cloud.attributes
        || layer.elevationRangeKey !== rangeKey) styleLayer(layer, cloud, sharedRange)
    layer.source = cloud
  }
  legendLayers.value = [...cloudLayers].map(([id, layer]) => ({ id, name: layer.source.name, legend: layer.legend }))
  updateLayerBounds()
  updateGrid()
  if (camerasChanged) {
    lastCameraMaps = cameraMaps
    lastCams = [...cameras].map(([uuid, { R, t }]) => ({ uuid, R, centre: new THREE.Vector3(
      -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2]),
      -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2]),
      -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2]),
    ) }))
    lastBaseDepth = cameraFrustumDepth(lastCams.map(c => c.centre), [])
    buildFrustums(lastCams, lastBaseDepth * cameraScale.value)
  }
  // Fit newly added layers together, including distant survey tiles. Selection,
  // symbology and visibility toggles preserve the user's camera position.
  if ((!hadContent || (addedCloud && !keepViewForEdit)) && cloudLayers.size) resetView()
  if (addedCloud) keepViewForEdit = false
  updateClipping()
  pruneSelections()
}

function zoomToCloud(id) {
  const layer = cloudLayers.get(id)
  if (!layer) return
  const center = sceneCenter.clone(), radius = sceneRadius
  sceneCenter.copy(layer.bounds.center); sceneRadius = layer.bounds.radius
  resetView()
  sceneCenter.copy(center); sceneRadius = radius
  updateClipping()
}

function updateClipping() {
  if (!camera || !controls) return
  const { near, far } = viewerClipping(sceneRadius, camera.position.distanceTo(controls.target), nearClip.value)
  if (Math.abs(camera.near - near) > near * 0.01 || Math.abs(camera.far - far) > far * 0.01) {
    camera.near = near; camera.far = far
    camera.updateProjectionMatrix()
  }
}

// (Re)build the camera-frustum glyphs at the given depth. Cheap: geometry is
// shared and thumbnails come from thumbCache, so only per-camera objects are new.
function buildFrustums(cams, frustumDepth) {
  clearFrustums()
  ensureFrustumGeometry()
  const urlByUuid = new Map(props.images.map((im) => [im.uuid, im.url]))
  for (const [uuid, entry] of thumbCache) {
    if (urlByUuid.get(uuid) !== entry.url) { disposeThumb(entry); thumbCache.delete(uuid) }
  }

  for (const { uuid, R, centre } of cams) {
    const obj = new THREE.Object3D()
    obj.matrixAutoUpdate = false
    obj.userData = { R, centre }
    obj.add(new THREE.LineSegments(frustumLineGeo, frustumLineMat))
    const url = urlByUuid.get(uuid)
    if (url) obj.add(new THREE.Mesh(frustumPlaneGeo, thumbFor(uuid, url).mat))
    placeFrustum(obj, frustumDepth)
    frustumGroup.add(obj)
  }
}

function clearReconstructionData() {
  setCloudLayers([])
}

// ── Point selection (rectangle / lasso) ──────────────────────────────────────
// Left-drag draws a shape while a tool is active; orbit/pan/zoom keep working on
// the other buttons and the wheel. Only dense clouds are selectable — a sparse
// cloud's points carry view-tracks (see core/products/cloudEdit.js), and a mesh's
// vertices are not points. The mask is computed over the exact Float32 buffer and
// matrix being drawn (core/products/screenSelect.js), so the highlight IS the
// selection. Selection is not reactive state: per-layer masks live here, keyed by
// cloud id and stamped with the source buffer, and are dropped whenever that
// layer's geometry is rebuilt.
const selectTool = ref(null)       // null | 'rect' | 'lasso'
const selectionCount = ref(0)
const selectionClouds = ref(0)
const drawShape = ref(null)        // { kind, points:[x,y,…] } in container px, for the SVG
const selections = new Map()       // cloudId → { mask, selected, pos, overlay }
let drawing = null                 // { op, startX, startY, pts }

function selectableLayers() {
  return [...cloudLayers].filter(([, l]) => l.source.kind === 'dense' && l.object.isPoints && l.object.visible)
}

function disposeSelectionOverlay(entry) {
  if (!entry?.overlay) return
  scene?.remove(entry.overlay)
  disposeObject(entry.overlay)
  entry.overlay = null
}

function refreshSelectionSummary() {
  let total = 0, clouds = 0
  for (const e of selections.values()) if (e.selected) { total += e.selected; clouds++ }
  selectionCount.value = total
  selectionClouds.value = clouds
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
    pos[k * 3] = src[i]; pos[k * 3 + 1] = src[i + 1]; pos[k * 3 + 2] = src[i + 2]
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const material = new THREE.PointsMaterial({
    color: 0xff3d71, size: pointSize.value + 1, sizeAttenuation: false,
    depthTest: false, depthWrite: false, transparent: true, opacity: 0.9,
  })
  const overlay = new THREE.Points(geometry, material)
  overlay.position.copy(layer.object.position)
  overlay.renderOrder = 10
  scene.add(overlay)
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
    if (!layer || layer.source.pos !== e.pos || !layer.object.visible
        || (layer.object.geometry.index ?? null) !== e.index) {
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

function pointerPx(e) {
  const r = container.value.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top]
}

// Capture-phase on the container: runs before OrbitControls' own pointerdown on
// the canvas, so a left-drag with a tool active never starts an orbit.
function onSelectPointerDown(e) {
  if (!selectTool.value || e.button !== 0 || !renderer || e.target !== renderer.domElement) return
  if (drawing) return // a second pointer must not hijack the stroke in progress
  e.stopPropagation()
  e.preventDefault()
  const [x, y] = pointerPx(e)
  drawing = {
    op: e.shiftKey ? 'add' : (e.altKey || e.ctrlKey || e.metaKey) ? 'subtract' : 'replace',
    startX: x, startY: y, pts: [x, y],
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
  if (!shapePx || !camera) return
  const w = container.value.clientWidth, h = container.value.clientHeight
  const ndc = shapePx.points.map((v, i) => (i % 2 === 0 ? (v / w) * 2 - 1 : 1 - (v / h) * 2))
  const shape = shapePx.kind === 'rect'
    ? { kind: 'rect', x0: ndc[0], y0: ndc[1], x1: ndc[2], y1: ndc[3] }
    : { kind: 'lasso', points: ndc }
  applySelectionShape(shape, op)
}

function applySelectionShape(shape, op) {
  camera.updateMatrixWorld()
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const layers = selectableLayers()
  const ids = new Set(layers.map(([id]) => id))
  if (op === 'replace') {
    for (const [id, e] of selections) if (!ids.has(id)) { disposeSelectionOverlay(e); selections.delete(id) }
  }
  for (const [id, layer] of layers) {
    layer.object.updateMatrixWorld()
    const matrix = viewProj.clone().multiply(layer.object.matrixWorld).elements
    const geometry = layer.object.geometry
    const prev = selections.get(id)
    const base = prev && prev.pos === layer.source.pos ? prev.mask : null
    const { mask, selected } = screenSelectMask(geometry.getAttribute('position').array, layer.count, {
      matrix, shape, indices: geometry.index?.array ?? null, base, op,
    })
    const entry = prev ?? { overlay: null }
    Object.assign(entry, { mask, selected, pos: layer.source.pos, index: geometry.index ?? null })
    if (selected) { selections.set(id, entry); buildSelectionOverlay(layer, entry) }
    else { disposeSelectionOverlay(entry); selections.delete(id) }
  }
  refreshSelectionSummary()
}

// Hand the masks to App (and on to the store). The masks are transferred to the
// worker there, so the local selection is cleared immediately.
function commitSelection(keepSelected) {
  const edits = [...selections].filter(([, e]) => e.selected).map(([cloudId, e]) => ({ cloudId, mask: e.mask }))
  if (!edits.length) return
  clearSelection()
  keepViewForEdit = true
  emit('edit-selection', { edits, keepSelected })
}

function onSelectKey(e) {
  if (!container.value?.offsetParent) return // tab hidden (v-show)
  const t = e.target
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
  if (e.key === 'Escape' && drawing) {
    // Abort the stroke in progress; the pointerup that follows finds nothing.
    drawing = null
    drawShape.value = null
  } else if (e.key === 'Escape' && (selectionCount.value || selectTool.value)) {
    if (selectionCount.value) clearSelection()
    else selectTool.value = null
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectionCount.value) {
    e.preventDefault()
    commitSelection(false)
  }
}

// ── Camera view presets ──────────────────────────────────────────────────────
// Presets are relative to the estimated scene up (sceneUp), not world axes, so a
// model in a tilted SfM frame still frames level (Top looks down sceneUp, the four
// sides are horizontal about it). Build an orthonormal {right, fwd, up} basis around
// sceneUp with a stable horizontal reference.
function upBasis() {
  const up = sceneUp.clone().normalize()
  // Reference axis to derive "horizontal" from — avoid the degenerate case where it
  // is parallel to up.
  const ref = Math.abs(up.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
  const right = new THREE.Vector3().crossVectors(up, ref).normalize()
  const fwd = new THREE.Vector3().crossVectors(right, up).normalize()
  return { up, right, fwd }
}

// Build the orbit controls against the camera's *current* `up`. Split out because
// OrbitControls derives its orbit axis from camera.up in its constructor and never
// recomputes it (no public setter, and the cached `_quat`/`_quatInverse` are
// private) — so retargeting up means rebuilding the controls; see syncControlsUp.
function makeControls() {
  const c = new OrbitControls(camera, renderer.domElement)
  c.enableDamping = true
  c.dampingFactor = 0.08
  // Zoom toward the cursor and drag the orbit pivot in with it: when zoomed deep
  // into the tie-points, orbit/pan then work around the region under the cursor
  // instead of the far scene centre (which otherwise makes navigation fiddly).
  c.zoomToCursor = true
  c.update()
  return c
}

// Whenever we retarget camera.up (the estimated scene up), rebuild the controls so
// their orbit axis follows — otherwise a horizontal drag twists instead of orbiting.
// Rebuilding uses only public API; poking the private `_quat` cache instead worked
// but silently breaks on a three.js upgrade. Callers set camera.up first, and the
// target is carried across (it is the one piece of state a fresh instance loses).
function syncControlsUp() {
  if (!controls || !camera || !renderer) return
  const target = controls.target.clone()
  controls.dispose()
  controls = makeControls()
  controls.target.copy(target)
  controls.update()
}

function setView(dir) {
  if (!camera || !controls) return
  const { up, right, fwd } = upBasis()
  const d = sceneRadius * 2.5
  let dirVec, camUp
  switch (dir) {
    // Top/bottom look along the up axis, so use an in-plane up (fwd) to avoid
    // OrbitControls gimbal-locking.
    case 'top':    dirVec = up.clone();            camUp = fwd.clone(); break
    case 'bottom': dirVec = up.clone().negate();   camUp = fwd.clone(); break
    case 'back':   dirVec = fwd.clone();           camUp = up.clone(); break
    case 'left':   dirVec = right.clone().negate(); camUp = up.clone(); break
    case 'right':  dirVec = right.clone();         camUp = up.clone(); break
    case 'front':
    default:       dirVec = fwd.clone().negate();  camUp = up.clone(); break
  }
  camera.up.copy(camUp)
  syncControlsUp()
  controls.target.copy(sceneCenter)
  camera.position.copy(sceneCenter).addScaledVector(dirVec, d)
  camera.updateProjectionMatrix()
  controls.update()
}

function resetView() {
  if (!camera || !controls) return
  const { up, right, fwd } = upBasis()
  camera.up.copy(up)
  syncControlsUp()
  controls.target.copy(sceneCenter)
  // Oblique bird's-eye: behind + to the side + above the scene centre, all relative
  // to the estimated up so the horizon is level.
  camera.position.copy(sceneCenter)
    .addScaledVector(fwd, -sceneRadius * 1.8)
    .addScaledVector(right, sceneRadius * 1.2)
    .addScaledVector(up, sceneRadius * 1.2)
  camera.updateProjectionMatrix()
  controls.update()
}

defineExpose({ setCloudLayers, clearReconstructionData, setView, resetView, zoomToCloud, toggleSelectTool })

function onResize() {
  const el = container.value
  if (!el || !renderer) return
  const w = el.clientWidth, h = el.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}

function animate() {
  animationId = requestAnimationFrame(animate)
  controls.update()
  updateClipping()
  renderer.render(scene, camera)
}

watch(() => props.theme, (t) => {
  if (!scene) return
  scene.background = new THREE.Color(backgroundColor())
  scene.remove(grid)
  disposeObject(grid)
  grid = makeGrid(t)
  updateGrid()
  scene.add(grid)
})

watch(background, () => {
  if (scene) scene.background = new THREE.Color(backgroundColor())
})

watch(() => props.showCameras, (v) => { if (frustumGroup) frustumGroup.visible = v })
watch(() => props.showGrid, (v) => { if (grid) grid.visible = v })
watch(gridZ, () => updateGrid())
// The reconstruction's up estimate can arrive/refine after content is already shown
// (e.g. a dense cloud selected before the sparse cameras are pushed). Re-orient the
// grid to it without yanking the user's current viewpoint.
watch(() => props.sceneUp, (u) => {
  if (u && u.length === 3) {
    sceneUp.set(u[0], u[1], u[2]).normalize()
    for (const layer of cloudLayers.values()) layer.bounds = robustBounds(layer.positions, layer.count, sceneUp)
    updateLayerBounds(); updateGrid()
  }
})

// ── Region box ────────────────────────────────────────────────────────────────
// A wireframe of the reconstruction region (Tools ▸ Model ▾ ▸ Region), in the
// scene's own (model) coordinates. Drawn on top so it reads through the cloud.
let regionHelper = null
function updateRegionBox(b) {
  if (regionHelper) { scene?.remove(regionHelper); disposeObject(regionHelper); regionHelper = null }
  if (!scene || !b?.min || !b?.max) return
  const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max))
  if (box.isEmpty()) return
  regionHelper = new THREE.Box3Helper(box, props.regionStale ? 0x888888 : 0xffb020)
  regionHelper.material.depthTest = false
  regionHelper.material.transparent = true
  regionHelper.material.opacity = props.regionStale ? 0.5 : 0.95
  regionHelper.renderOrder = 11
  scene.add(regionHelper)
}
watch([() => props.regionBox, () => props.regionStale], ([b]) => updateRegionBox(b), { deep: true })

// ── Point picking (tool-driven) ───────────────────────────────────────────────
// While `pickMode` is set, a click WITHOUT a drag (a drag still orbits) picks the
// drawn point nearest the camera within a few pixels (core/products/screenPick.js,
// on the Float32 render buffer and the matrix that drew it) and emits its EXACT
// Float64 source coordinates: { cloudId, index, position:[x,y,z] }.
const PICK_RADIUS_PX = 8
let pickDown = null
function onPickPointerDown(e) {
  if (!props.pickMode || e.button !== 0 || !renderer || e.target !== renderer.domElement) { pickDown = null; return }
  pickDown = { x: e.clientX, y: e.clientY }
}
function onPickPointerUp(e) {
  const down = pickDown
  pickDown = null
  if (!down || !props.pickMode || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
  const [px, py] = pointerPx(e)
  const w = container.value.clientWidth, h = container.value.clientHeight
  const x = (px / w) * 2 - 1, y = 1 - (py / h) * 2
  const tolX = (2 * PICK_RADIUS_PX) / w, tolY = (2 * PICK_RADIUS_PX) / h
  camera.updateMatrixWorld()
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const allowed = props.pickMode.cloudIds ? new Set(props.pickMode.cloudIds) : null
  let best = null
  for (const [id, layer] of cloudLayers) {
    if (!layer.object.visible || (allowed && !allowed.has(id))) continue
    layer.object.updateMatrixWorld()
    const matrix = viewProj.clone().multiply(layer.object.matrixWorld).elements
    const geometry = layer.object.geometry
    // A mesh's index lists triangle corners; any drawn vertex may be picked.
    const indices = layer.object.isPoints ? (geometry.index?.array ?? null) : null
    const hit = pickNearestPoint(geometry.getAttribute('position').array, layer.count, { matrix, x, y, tolX, tolY, indices })
    if (hit && (!best || hit.depth < best.depth)) best = { ...hit, id, layer }
  }
  if (!best) return
  const src = best.layer.positions
  const i = best.index
  emit('pick', { cloudId: best.id, index: i, position: [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]] })
}

// Tool markers, drawn on top of everything. Positions relative to the first marker
// so a survey-coordinate pick keeps its precision in the Float32 GPU buffer.
let markerObject = null
function updateMarkers(markers) {
  if (markerObject) { scene?.remove(markerObject); disposeObject(markerObject); markerObject = null }
  if (!scene || !markers?.length) return
  const o = markers[0].position
  const pos = new Float32Array(markers.length * 3), col = new Float32Array(markers.length * 3)
  markers.forEach((m, k) => {
    pos[k * 3] = m.position[0] - o[0]; pos[k * 3 + 1] = m.position[1] - o[1]; pos[k * 3 + 2] = m.position[2] - o[2]
    const c = new THREE.Color(m.color || '#ffb020')
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const material = new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true })
  markerObject = new THREE.Points(geometry, material)
  markerObject.position.set(o[0], o[1], o[2])
  markerObject.renderOrder = 12
  scene.add(markerObject)
}
watch(() => props.markers, updateMarkers, { deep: true })

// Ribbon steppers — cheap live updates, no cloud recompute.
watch(cameraScale, () => scaleFrustums(lastBaseDepth * cameraScale.value))
// A thumbnail url can arrive or change after the frustums were built (TIFF display
// transcode, a healed blob: url). A string key compares by value.
watch(() => props.images.map(im => `${im.uuid}|${im.url ?? ''}`).join('\n'), () => {
  if (scene && lastCams.length) buildFrustums(lastCams, lastBaseDepth * cameraScale.value)
})
watch(pointSize, (v) => {
  for (const { object } of cloudLayers.values()) if (object.isPoints) object.material.size = v
  for (const e of selections.values()) if (e.overlay) e.overlay.material.size = v + 1
})
watch(nearClip, updateClipping)

// No right-click context menu here on purpose: OrbitControls uses the right mouse
// button to pan, so any menu competes with the primary navigation gesture. Coordinate
// readout stays in the 2D views (image / map).

onMounted(() => {
  init()
  window.addEventListener('keydown', onSelectKey)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('keydown', onSelectKey)
  clearSelection()
  resizeObserver?.disconnect()
  disposeFrustumResources()
  for (const { object } of cloudLayers.values()) disposeObject(object)
  cloudLayers.clear()
  if (grid) { disposeObject(grid); grid = null }
  controls?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div ref="container" class="viewer" :class="{ selecting: !!selectTool || !!pickMode }" @contextmenu.prevent
    @pointerdown.capture="(e) => { onPickPointerDown(e); onSelectPointerDown(e) }" @pointermove="onSelectPointerMove"
    @pointerup="(e) => { onSelectPointerUp(e); onPickPointerUp(e) }" @pointercancel="onSelectPointerUp">
    <!-- WebGL unavailable: degrade gracefully instead of crashing app mount. -->
    <div v-if="glError" class="gl-error">
      <div class="gl-error-box">{{ glError }}</div>
    </div>

    <CloudLegend v-if="showLegend" :layers="legendLayers" />

    <svg v-if="drawShape" class="select-shape" aria-hidden="true">
      <rect v-if="drawShape.kind === 'rect'"
        :x="Math.min(drawShape.points[0], drawShape.points[2])" :y="Math.min(drawShape.points[1], drawShape.points[3])"
        :width="Math.abs(drawShape.points[2] - drawShape.points[0])" :height="Math.abs(drawShape.points[3] - drawShape.points[1])" />
      <polygon v-else :points="drawShape.points.join(' ')" />
    </svg>

    <!-- Toolboxes of tools that live outside this component (Region, point-pair
         alignment) render over the 3D view here. -->
    <slot name="toolbox" />

    <!-- The selection tool's toolbox. The ribbon (View ▸ Select) chooses the tool;
         what you do with the selection lives here. -->
    <FloatingToolbox v-if="selectTool || selectionCount" id="select-3d" title="Select points" anchor="top-center"
      :width="260" close-title="Stop selecting (Esc)" @close="exitSelection">
      <template v-if="selectionCount">
        <div class="tb-line">
          <span class="tb-count">{{ selectionCount.toLocaleString() }}</span>
          point{{ selectionCount === 1 ? '' : 's' }} selected<template v-if="selectionClouds > 1"> in {{ selectionClouds }} clouds</template>
        </div>
        <div class="tb-row">
          <button class="tb-textbtn danger" title="Delete the selected points (Delete)" @click="commitSelection(false)">Delete</button>
          <button class="tb-textbtn" title="Keep only the selected points" @click="commitSelection(true)">Keep only</button>
          <button class="tb-textbtn" title="Clear the selection (Esc)" @click="clearSelection">Clear</button>
        </div>
      </template>
      <div v-else class="tb-hint">
        {{ selectableLayers().length
          ? `Drag a ${selectTool === 'lasso' ? 'lasso' : 'rectangle'} over dense-cloud points · Shift adds · Alt subtracts · Esc exits`
          : 'Show a dense cloud to select its points' }}
      </div>
    </FloatingToolbox>
  </div>
</template>

<style scoped>
.viewer {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.gl-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  pointer-events: none;
}
.gl-error-box {
  max-width: 360px;
  padding: 14px 16px;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.5;
  text-align: center;
}

.overlay {
  position: absolute;
  top: 12px;
  left: 16px;
  font-size: 12px;
  color: var(--text-dim);
  pointer-events: none;
  user-select: none;
}

.viewer.selecting :deep(canvas) {
  cursor: crosshair;
}

.select-shape {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.select-shape rect,
.select-shape polygon {
  fill: rgba(255, 61, 113, 0.12);
  stroke: #ff3d71;
  stroke-width: 1.5;
  stroke-dasharray: 5 3;
}
</style>

<style scoped src="./toolbox.css"></style>
