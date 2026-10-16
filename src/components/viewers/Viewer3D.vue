<script setup>
import { relativePositions } from '../../core/products/pointView.ts'
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
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
import { settleEditLatch } from '../../core/products/editFraming.js'
import { viewerMayHandleKey } from '../../utils/keyRouting.js'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { texturePageBlobs } from '../../stores/reconstruction/meshTexture.js'
import { useMeasurementsStore } from '../../stores/useMeasurementsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { createLodLayer, LOD_VIEW_MIN } from './lodLayer.js'
import { polyline3d, polygon3d } from '../../core/products/measure.js'
import { cloudUnits, formatMeasure } from '../../core/products/cloudUnits.js'

// pointSize / cameraScale are set from the ribbon's View ▸ Scene steppers.
const { gridZ, background, nearClip, pointSize, cameraScale, pointBudget } = useViewerSettings()
const imagesStore = useImagesStore()

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
  // What a model-unit length means now (store currentFrameSignature): 3D measurements
  // print metres only when the project has a georeference or scale bars.
  frameSignature: { type: Object, default: null },
})
// Emits ribbon command ids so App's handleCommand routes them (toggles live in App).
// `edit-selection` carries { edits: [{ cloudId, mask }], keepSelected } for App to
// apply through the store's non-destructive cloud-edit path. `select-tool` reports
// the active selection tool (null | 'rect' | 'lasso') so the ribbon's View ▸ Select
// toggles can show it — the same up-reporting raster measuring uses.
const emit = defineEmits(['command', 'edit-selection', 'select-tool', 'pick', 'measure-tool'])

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
// Vertex colours go to the GPU as the style's own Uint8 sRGB bytes (normalized
// attribute, 3 B/point) and are decoded to linear in the vertex shader — Three.js
// shades vertex colours in linear space, and the source RGB, ramp colours and legend
// swatches are sRGB. A Float32 linear copy was 12 B/point on the CPU and the GPU
// (240 MB for a 20 M-point cloud). The decode is Three's own SRGBToLinear formula,
// so colours are unchanged. One shared function, so every cloud material shares a
// program (Three keys programs on onBeforeCompile's source).
function srgbVertexColors(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
vec3 websfmSrgbToLinear(vec3 c) {
  return mix(c * 0.0773993808, pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), step(vec3(0.04045), c));
}`)
    .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR
  vColor.rgb = websfmSrgbToLinear(vColor.rgb);
#endif`)
}
let lastCameraMaps = []
let knownCloudIds = new Set()
// The cloud ids a committed selection edit will rewrite: its result (a derived
// fork of a computed/imported source, or the derived cloud refined in place)
// replaces the one the user was zoomed into, so it must not re-frame the scene the
// way a newly imported cloud does. Settled per layer update (see settleEditLatch),
// so a failed or cancelled edit does not suppress framing of a later import.
let editPendingIds = new Set()
// Imported point buffers are immutable; replacing a buffer invalidates its range.
const elevationRanges = new WeakMap()
function cachedElevationRange(cloud) {
  if (cloud.lod?.bounds) return { min: cloud.lod.bounds.min[2], max: cloud.lod.bounds.max[2] }
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
// the lag. The texture source is the image's LIST THUMBNAIL (img.thumb, ≤256 px,
// useImagesStore) — never the full-resolution photo, which for 5,000 cameras meant
// 5,000 full decodes per session. A missing thumbnail is requested in the
// background; `thumbsVersion` says when one lands. An entry is dropped only when
// its image is removed.
const THUMB_PX = 256
const THUMB_DECODES = 4 // concurrent thumbnail decodes (each ≤ THUMB_PX², cheap)
const thumbCache = new Map() // uuid → { url, tex, mat, queued, disposed }
const thumbQueue = []
let thumbActive = 0
let thumbSyncRaf = 0
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

// A cloud layer's object plus the material it is not showing right now (a textured
// mesh swaps between its lit base material and one unlit material per atlas page).
function disposeLayer(layer) {
  if (layer.lod) { layer.dispose(); return }
  disposeObject(layer.object)
  const textures = new Set(), materials = new Set()
  if (layer.baseMaterial && layer.baseMaterial !== layer.object.material) disposeMaterial(layer.baseMaterial, textures, materials)
  if (layer.pageMaterials && layer.pageMaterials !== layer.object.material) disposeMaterial(layer.pageMaterials, textures, materials)
}

// The atlas pages of a textured mesh as unlit materials, one per page (the geometry's
// groups say which faces use which). The pages decode asynchronously; a page shows grey
// until its texture is up. A page larger than this GPU's texture limit is downscaled
// for display only. UVs follow glTF (v down from the top row), so no flip.
function pageMaterials(layer, cloud) {
  if (layer.pageMaterials && layer.pageSource === cloud.texture) return layer.pageMaterials
  if (layer.pageMaterials && layer.pageMaterials !== layer.object.material) disposeMaterial(layer.pageMaterials)
  const blobs = texturePageBlobs(cloud.texture)
  const mats = blobs.map(() => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, color: 0xbbbbbb }))
  layer.pageMaterials = mats
  layer.pageSource = cloud.texture
  const max = renderer.capabilities.maxTextureSize
  blobs.forEach(async (blob, i) => {
    try {
      let bmp = await createImageBitmap(blob)
      if (bmp.width > max || bmp.height > max) {
        const s = max / Math.max(bmp.width, bmp.height)
        const w = Math.floor(bmp.width * s), h = Math.floor(bmp.height * s)
        bmp.close()
        bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
      }
      if (unmounted || layer.pageMaterials !== mats) { bmp.close(); return }
      const tex = new THREE.Texture(bmp)
      tex.flipY = false
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.needsUpdate = true
      mats[i].map = tex
      mats[i].color.set(0xffffff)
      mats[i].needsUpdate = true
      requestRender()
    } catch (err) {
      console.warn('Texture page could not be decoded', err)
    }
  })
  return mats
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
    entry.queued = false
    if (entry.disposed || !entry.url) continue
    const url = entry.url
    thumbActive++
    // createImageBitmap decodes off the main thread and resizes in one step.
    // The bitmap is flipped here because WebGL ignores UNPACK_FLIP_Y for it.
    fetch(url)
      .then(r => r.blob())
      .then(blob => createImageBitmap(blob, {
        resizeWidth: THUMB_PX, resizeHeight: THUMB_PX, resizeQuality: 'medium', imageOrientation: 'flipY',
      }))
      .then((bitmap) => {
        if (entry.disposed || entry.url !== url) { bitmap.close(); return }
        entry.tex.image?.close?.()
        entry.tex.image = bitmap
        entry.tex.needsUpdate = true
        requestRender()
      })
      .catch(() => {}) // a dead blob: url just leaves the quad untextured
      .finally(() => { thumbActive--; pumpThumbQueue() })
  }
}

function thumbEntry(uuid) {
  let entry = thumbCache.get(uuid)
  if (entry) return entry
  const tex = new THREE.Texture()
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  entry = { url: null, tex, mat: new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }), queued: false, disposed: false }
  thumbCache.set(uuid, entry)
  return entry
}

// Point a glyph's texture at the image's list thumbnail; load it when it changed.
function syncThumb(entry, img) {
  const url = img.thumb?.url ?? null
  if (!url || entry.url === url) return
  entry.url = url
  if (!entry.queued) { entry.queued = true; thumbQueue.push(entry) }
  pumpThumbQueue()
}

// A thumbnail landed somewhere (thumbsVersion moved): re-point the glyphs, one pass
// per frame however many arrived.
function scheduleThumbSync() {
  if (!thumbSyncRaf) thumbSyncRaf = requestAnimationFrame(syncAllThumbs)
}
function syncAllThumbs() {
  thumbSyncRaf = 0
  if (!thumbCache.size) return
  const imgByUuid = new Map(props.images.map((im) => [im.uuid, im]))
  for (const [uuid, entry] of thumbCache) {
    const img = imgByUuid.get(uuid)
    if (img) syncThumb(entry, img)
  }
}

// Missing thumbnails are asked for only once the glyphs are actually drawn (the view
// in front, cameras shown): a hidden 3D tab must not make a freshly opened
// 5,000-image project generate a thumbnail for every camera. Background priority.
let thumbRequestsPending = false
function requestMissingThumbs() {
  thumbRequestsPending = false
  const imgByUuid = new Map(props.images.map((im) => [im.uuid, im]))
  for (const [uuid, entry] of thumbCache) {
    const img = imgByUuid.get(uuid)
    if (img && !entry.url && !img.thumb && !img.previewFailed) imagesStore.requestThumbnail(img)
  }
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

  requestRender()
}

// ── Reconstruction visualisation ─────────────────────────────────────────────

// A big dense cloud with an octree (or a streamed one, which has only that) is drawn
// level of detail (lodLayer.js): a point budget's worth of nodes for the current view.
// Selecting and index picking need every point drawn: while either is active, a cloud
// whose points are in memory is drawn whole again (a streamed one cannot be).
const reconStore = useReconstructionStore()
const needsAllPoints = () => !!selectTool.value || !!props.pickMode
const usesLod = (cloud) => cloud.kind === 'dense' && !!cloud.lod
  && (!cloud.pos || (cloud.count >= LOD_VIEW_MIN && !needsAllPoints()))
function createLodCloudLayer(cloud) {
  const material = new THREE.PointsMaterial({ size: pointSize.value, sizeAttenuation: false })
  material.onBeforeCompile = srgbVertexColors
  const layer = createLodLayer(cloud, {
    open: (c) => reconStore.openCloudLod(c),
    material,
    onChange: () => {
      // The root node gives better framing bounds than the octree's box.
      if (layer.rootPoints && !layer.rootBounds && cloudLayers.get(cloud.id) === layer) {
        layer.rootBounds = true
        layer.bounds = layerBounds(layer)
        updateLayerBounds(); updateGrid()
      }
      requestRender()
    },
  })
  layer.bounds = layerBounds(layer)
  scene.add(layer.object)
  return layer
}
const layerBounds = (layer) => (layer.lod ? layer.boundsFor(sceneUp, robustBounds) : robustBounds(layer.positions, layer.count, sceneUp))

function createCloudLayer(cloud) {
  if (usesLod(cloud)) return createLodCloudLayer(cloud)
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
    // A textured mesh: UVs, and its faces grouped by atlas page (material index).
    if (cloud.uv && cloud.texture?.groups?.length) {
      geometry.setAttribute('uv', new THREE.BufferAttribute(cloud.uv, 2))
      for (const g of cloud.texture.groups) geometry.addGroup(3 * g.start, 3 * g.count, g.page)
    }
  }
  geometry.computeBoundingSphere()
  const material = isMesh
    ? new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.95, metalness: 0 })
    : new THREE.PointsMaterial({ size: pointSize.value, sizeAttenuation: false })
  material.onBeforeCompile = srgbVertexColors
  const object = isMesh ? new THREE.Mesh(geometry, material) : new THREE.Points(geometry, material)
  object.position.set(...origin)
  object.userData.cloudId = cloud.id
  scene.add(object)
  return { object, baseMaterial: material, positions, count, source: cloud, bounds: robustBounds(positions, count, sceneUp) }
}

// Free the GPU buffers of the style-owned attributes (colour, a point cloud's
// class-filter index) WITHOUT touching the geometry's position/normal buffers or a
// mesh's triangle index. `geometry.dispose()` releases every attribute's buffer, so
// disposing to drop a replaced colour buffer used to re-upload the whole position
// buffer on each restyle (12 B/point). The kept attributes are detached for the
// dispose and re-attached: their GL buffers stay resident in the renderer, keyed by
// the attribute object, and the next draw reuses them as-is.
function releaseStyleBuffers(geometry, { keepColor, keepIndex }) {
  const kept = []
  for (const name of Object.keys(geometry.attributes)) {
    if (name === 'color' && !keepColor) continue
    kept.push([name, geometry.getAttribute(name)])
    geometry.deleteAttribute(name)
  }
  const index = keepIndex ? geometry.index : null
  if (index) geometry.setIndex(null)
  geometry.dispose()
  for (const [name, attribute] of kept) geometry.setAttribute(name, attribute)
  if (index) geometry.setIndex(index)
}

function styleLayer(layer, cloud, elevationRange) {
  if (layer.lod) {
    layer.legend = layer.restyle(cloud, elevationRange)
    layer.style = cloud.style
    layer.elevationRangeKey = elevationRange ? `${elevationRange.min}:${elevationRange.max}` : ''
    return
  }
  const visual = buildCloudStyle(cloud, undefined, { elevationRange })
  const { geometry } = layer.object
  const material = layer.baseMaterial ?? layer.object.material
  if (visual.texture) {
    const mats = pageMaterials(layer, cloud)
    for (const m of mats) {
      m.opacity = visual.style.opacity
      m.transparent = visual.style.opacity < 1
      m.depthWrite = visual.style.opacity === 1
    }
    layer.object.material = mats
  } else if (layer.baseMaterial) layer.object.material = layer.baseMaterial
  const isMesh = cloud.kind === 'mesh'
  const colors = visual.colors
    ? (visual.colors instanceof Uint8Array ? visual.colors : Uint8Array.from(visual.colors)) : null
  const indices = isMesh ? null : (visual.indices ?? null)
  // A restyle that keeps the same colour bytes (an RGB cloud's own `col`) and the same
  // index keeps its buffers; only what changed is replaced (and only that re-uploads).
  const colorAttr = geometry.getAttribute('color')
  const sameColors = colorAttr ? colorAttr.array === colors : !colors
  const sameIndex = isMesh || (geometry.index?.array ?? null) === indices
  if (layer.legend && (!sameColors || !sameIndex)) {
    releaseStyleBuffers(geometry, { keepColor: sameColors, keepIndex: sameIndex })
  }
  if (!sameColors) {
    // Uint8 sRGB, normalized; decoded to linear in the shader (srgbVertexColors).
    if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true))
    else geometry.deleteAttribute('color')
  }
  if (!sameIndex) geometry.setIndex(indices ? new THREE.BufferAttribute(indices, 1) : null)
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
let lastClouds = []
function setCloudLayers(clouds) {
  lastClouds = clouds
  if (!scene) return
  const hadContent = cloudLayers.size > 0 || frustumGroup.children.length > 0
  const addedCloud = clouds.some(c => c.visible !== false && !knownCloudIds.has(c.id))
  // Read against the layers as last drawn, before this update reconciles them.
  const edit = settleEditLatch(editPendingIds, clouds, (id) => cloudLayers.get(id)?.source, addedCloud)
  editPendingIds = edit.pending
  knownCloudIds = new Set(clouds.map(c => c.id))
  const visible = clouds.filter(c => c.visible !== false)
  const elevationRange = sharedElevationRange(clouds, cachedElevationRange)
  const ids = new Set(visible.map(c => c.id))
  for (const [id, layer] of cloudLayers) {
    if (!ids.has(id)) { scene.remove(layer.object); disposeLayer(layer); cloudLayers.delete(id) }
  }
  const cameraMaps = visible.map(c => c.cameras).filter(Boolean)
  const camerasChanged = cameraMaps.length !== lastCameraMaps.length || cameraMaps.some((m, i) => m !== lastCameraMaps[i])
  const cameras = new Map()
  for (const map of cameraMaps) for (const [id, cam] of map) cameras.set(id, cam)
  const up = props.sceneUp || estimateUpFromCameras(cameras)
  const prevUp = sceneUp.clone()
  if (up) sceneUp.set(...up).normalize()
  else sceneUp.set(0, 0, 1)
  // Bounds are measured along sceneUp: when the estimate moved (new cameras, no
  // prop), the layers kept below must be re-measured like the prop watcher does.
  const upChanged = !prevUp.equals(sceneUp)
  for (const cloud of visible) {
    let layer = cloudLayers.get(cloud.id)
    if (layer && (layer.source.pos !== cloud.pos || layer.source.points !== cloud.points || layer.source.idx !== cloud.idx
        || layer.source.uv !== cloud.uv || layer.source.count !== cloud.count || layer.source.kind !== cloud.kind
        || !!layer.lod !== usesLod(cloud) || (layer.lod && layer.source.lod !== cloud.lod))) {
      scene.remove(layer.object); disposeLayer(layer); cloudLayers.delete(cloud.id); layer = null
    }
    if (!layer) {
      layer = createCloudLayer(cloud)
      if (!layer) continue
      cloudLayers.set(cloud.id, layer)
    } else if (upChanged) {
      layer.bounds = layerBounds(layer)
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
  if ((!hadContent || (addedCloud && !edit.editResult)) && cloudLayers.size) resetView()
  updateClipping()
  pruneSelections()
  requestRender()
}

function zoomToCloud(id) {
  const layer = cloudLayers.get(id)
  if (!layer) return
  const center = sceneCenter.clone(), radius = sceneRadius
  sceneCenter.copy(layer.bounds.center); sceneRadius = layer.bounds.radius
  resetView()
  sceneCenter.copy(center); sceneRadius = radius
  updateClipping()
  requestRender()
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
  const imgByUuid = new Map(props.images.map((im) => [im.uuid, im]))
  for (const [uuid, entry] of thumbCache) {
    if (!imgByUuid.has(uuid)) { disposeThumb(entry); thumbCache.delete(uuid) }
  }

  for (const { uuid, R, centre } of cams) {
    const obj = new THREE.Object3D()
    obj.matrixAutoUpdate = false
    obj.userData = { R, centre }
    obj.add(new THREE.LineSegments(frustumLineGeo, frustumLineMat))
    const img = imgByUuid.get(uuid)
    if (img) {
      const entry = thumbEntry(uuid)
      obj.add(new THREE.Mesh(frustumPlaneGeo, entry.mat))
      syncThumb(entry, img)
      if (!entry.url) thumbRequestsPending = true
    }
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
watch([() => !!selectTool.value, () => !!props.pickMode], () => setCloudLayers(lastClouds))

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
function commitSelection(keepSelected, classValue = null) {
  const edits = [...selections].filter(([, e]) => e.selected).map(([cloudId, e]) => ({ cloudId, mask: e.mask }))
  if (!edits.length) return
  clearSelection()
  editPendingIds = new Set(edits.map((e) => e.cloudId))
  emit('edit-selection', { edits, keepSelected, classValue })
}
// Manual reclassification: the LAS classes offered for a selection (TODO ▸ F14).
const ASSIGN_CLASSES = [[2, 'Ground'], [1, 'Unclassified'], [3, 'Low vegetation'], [4, 'Medium vegetation'],
  [5, 'High vegetation'], [6, 'Building'], [9, 'Water'], [7, 'Low noise'], [18, 'High noise']]
const assignClass = ref(2)

// Keys reach this before App's global handler (see utils/keyRouting): nothing is
// done while a dialog is open or a field has focus, and a key acted on is consumed
// so App does not also close a modal or leave the active 3D tool on the same press.
function onSelectKey(e) {
  if (!container.value?.offsetParent) return // tab hidden (v-show)
  if (!viewerMayHandleKey(e)) return
  if (measureTool.value) {
    if (e.key === 'Escape') { e.preventDefault(); if (measurePts.value.length) clearMeasure(); else exitMeasure(); return }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); undoMeasure(); return }
    if (e.key === 'Enter') { e.preventDefault(); finishMeasure(); return }
  }
  if (e.key === 'Escape' && drawing) {
    // Abort the stroke in progress; the pointerup that follows finds nothing.
    e.preventDefault()
    drawing = null
    drawShape.value = null
  } else if (e.key === 'Escape' && (selectionCount.value || selectTool.value)) {
    e.preventDefault()
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
  // Every user gesture runs `update()`, which dispatches 'change' when the camera
  // moved: that is what wakes the on-demand render loop.
  c.addEventListener('change', requestRender)
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
  requestRender()
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
  requestRender()
}

defineExpose({ setCloudLayers, clearReconstructionData, setView, resetView, zoomToCloud, toggleSelectTool, toggleMeasureTool })

function onResize() {
  const el = container.value
  if (!el || !renderer) return
  const w = el.clientWidth, h = el.clientHeight
  // A tab hidden under v-show measures 0×0; keep the last real size (the observer
  // fires again, with the real size, when the tab comes back to the front).
  if (!w || !h) return
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  requestRender()
}

// ── On-demand rendering ──────────────────────────────────────────────────────
// A frame is drawn only when something changed: a camera move (OrbitControls
// 'change', including the damping glide after release, which keeps requesting
// frames while `update()` still moves the camera), a resize or tab switch (the
// ResizeObserver), or a scene edit (every mutation path below calls requestRender).
// A continuous loop redrew a multi-million-point cloud 60× a second while nothing
// moved, competing with WebGPU compute for the GPU and draining laptop batteries.
// Tabs stay mounted under v-show; a hidden view defers its frame until it is shown.
let frameRequested = false
let unmounted = false
function requestRender() {
  if (frameRequested || !renderer || unmounted) return
  frameRequested = true
  animationId = requestAnimationFrame(renderFrame)
}
function renderFrame() {
  frameRequested = false
  if (!renderer || !scene || !camera || !controls) return
  if (!container.value?.offsetParent) return // hidden: the resize on show re-requests
  // Damping: update() keeps moving the camera for a while after the gesture ends and
  // returns true while it does; its 'change' event re-requests the next frame.
  controls.update()
  updateClipping()
  // Level-of-detail layers choose their nodes for this view (and fetch missing ones).
  for (const layer of cloudLayers.values()) {
    if (layer.lod && layer.object.visible) layer.update(camera, renderer.domElement.clientHeight || 1, pointBudget.value * 1e6)
  }
  renderer.render(scene, camera)
  if (thumbRequestsPending && frustumGroup.visible) requestMissingThumbs()
}

watch(() => props.theme, (t) => {
  if (!scene) return
  scene.background = new THREE.Color(backgroundColor())
  scene.remove(grid)
  disposeObject(grid)
  grid = makeGrid(t)
  updateGrid()
  scene.add(grid)
  requestRender()
})

watch(background, () => {
  if (scene) scene.background = new THREE.Color(backgroundColor())
  requestRender()
})

watch(() => props.showCameras, (v) => { if (frustumGroup) frustumGroup.visible = v; requestRender() })
watch(() => props.showGrid, (v) => { if (grid) grid.visible = v; requestRender() })
watch(gridZ, () => { updateGrid(); requestRender() })
// The reconstruction's up estimate can arrive/refine after content is already shown
// (e.g. a dense cloud selected before the sparse cameras are pushed). Re-orient the
// grid to it without yanking the user's current viewpoint.
watch(() => props.sceneUp, (u) => {
  if (u && u.length === 3) {
    sceneUp.set(u[0], u[1], u[2]).normalize()
    for (const layer of cloudLayers.values()) layer.bounds = layerBounds(layer)
    updateLayerBounds(); updateGrid()
    requestRender()
  }
})

// ── Region box ────────────────────────────────────────────────────────────────
// A wireframe of the reconstruction region (Tools ▸ Model ▾ ▸ Region), in the
// scene's own (model) coordinates. Drawn on top so it reads through the cloud.
let regionHelper = null
function updateRegionBox(b) {
  if (regionHelper) { scene?.remove(regionHelper); disposeObject(regionHelper); regionHelper = null }
  requestRender()
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
  if ((!props.pickMode && !measureTool.value) || e.button !== 0 || !renderer || e.target !== renderer.domElement) { pickDown = null; return }
  pickDown = { x: e.clientX, y: e.clientY }
}
function onPickPointerUp(e) {
  const down = pickDown
  pickDown = null
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
  if (!props.pickMode) { if (measureTool.value) measureClick(e); return }
  const [px, py] = pointerPx(e)
  const w = container.value.clientWidth, h = container.value.clientHeight
  const x = (px / w) * 2 - 1, y = 1 - (py / h) * 2
  const tolX = (2 * PICK_RADIUS_PX) / w, tolY = (2 * PICK_RADIUS_PX) / h
  camera.updateMatrixWorld()
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const allowed = props.pickMode.cloudIds ? new Set(props.pickMode.cloudIds) : null
  let best = null
  for (const [id, layer] of cloudLayers) {
    // A level-of-detail layer draws nodes, not the cloud's indexed points.
    if (layer.lod || !layer.object.visible || (allowed && !allowed.has(id))) continue
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
  camera.updateMatrixWorld()
  let best = null
  const meshes = [...cloudLayers.values()].filter((l) => l.object.isMesh && l.object.visible).map((l) => l.object)
  if (meshes.length) {
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
    const hit = raycaster.intersectObjects(meshes, false)[0]
    if (hit) best = { pos: [hit.point.x, hit.point.y, hit.point.z], cloudId: hit.object.userData.cloudId, dist: hit.distance }
  }
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const tolX = (2 * PICK_RADIUS_PX) / w, tolY = (2 * PICK_RADIUS_PX) / h
  for (const [id, layer] of cloudLayers) {
    if (layer.lod && layer.object.visible) {
      const hit = layer.pick({ viewProj, x, y, tolX, tolY })
      const dist = hit && camera.position.distanceTo(new THREE.Vector3(...hit.pos))
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
    const dist = camera.position.distanceTo(new THREE.Vector3(...pos))
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
  })
}

// The overlay: the current outline bright, saved ones dim; on top of the scene.
function drawMeasure() {
  if (measureObject) { scene?.remove(measureObject); disposeObject(measureObject); measureObject = null }
  requestRender()
  if (!scene || !measureTool.value) return
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
  scene.add(group)
}
watch(saved3d, drawMeasure)

// Tool markers, drawn on top of everything. Positions relative to the first marker
// so a survey-coordinate pick keeps its precision in the Float32 GPU buffer.
let markerObject = null
function updateMarkers(markers) {
  if (markerObject) { scene?.remove(markerObject); disposeObject(markerObject); markerObject = null }
  requestRender()
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
watch(cameraScale, () => { scaleFrustums(lastBaseDepth * cameraScale.value); requestRender() })
// A list thumbnail can land after the frustums were built (generated in the
// background, or regenerated). One counter instead of a watch over every image.
watch(() => imagesStore.thumbsVersion, scheduleThumbSync)
// An image joining or leaving re-points glyphs too (a camera whose image arrives
// late). Debounced: a multi-thousand-image drop changes the length once per file,
// and each rebuild touches every camera.
let frustumRebuildTimer = 0
watch(() => props.images.length, () => {
  clearTimeout(frustumRebuildTimer)
  frustumRebuildTimer = setTimeout(() => {
    if (unmounted || !scene || !lastCams.length) return
    buildFrustums(lastCams, lastBaseDepth * cameraScale.value)
    requestRender()
  }, 300)
})
watch(pointSize, (v) => {
  for (const layer of cloudLayers.values()) {
    if (layer.lod) layer.baseMaterial.size = v
    else if (layer.object.isPoints) layer.object.material.size = v
  }
  for (const e of selections.values()) if (e.overlay) e.overlay.material.size = v + 1
  requestRender()
})
watch(nearClip, () => { updateClipping(); requestRender() })
watch(pointBudget, () => requestRender())

// No right-click context menu here on purpose: OrbitControls uses the right mouse
// button to pan, so any menu competes with the primary navigation gesture. Coordinate
// readout stays in the 2D views (image / map).

onMounted(() => {
  init()
  window.addEventListener('keydown', onSelectKey)
})

onBeforeUnmount(() => {
  unmounted = true
  cancelAnimationFrame(animationId)
  if (thumbSyncRaf) cancelAnimationFrame(thumbSyncRaf)
  clearTimeout(frustumRebuildTimer)
  window.removeEventListener('keydown', onSelectKey)
  clearSelection()
  resizeObserver?.disconnect()
  disposeFrustumResources()
  for (const layer of cloudLayers.values()) disposeLayer(layer)
  cloudLayers.clear()
  if (grid) { disposeObject(grid); grid = null }
  controls?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div ref="container" class="viewer" :class="{ selecting: !!selectTool || !!pickMode || !!measureTool }" @contextmenu.prevent
    @dblclick="measureTool && finishMeasure()"
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

    <!-- 3D measuring (Tools ▸ Measure ▸ Measure in 3D). -->
    <FloatingToolbox v-if="measureTool" id="measure-3d" title="Measure in 3D" anchor="top-center" :width="300"
      close-title="Stop measuring (Esc)" @close="exitMeasure">
      <div class="tb-row" role="group" aria-label="Measure">
        <button v-for="t in [['distance', 'Distance'], ['polyline', 'Polyline'], ['area', 'Area']]" :key="t[0]"
          class="tb-textbtn" :class="{ active: measureTool === t[0] }" :aria-pressed="measureTool === t[0]"
          @click="measureTool = t[0]; clearMeasure()">{{ t[1] }}</button>
      </div>
      <template v-if="measureResult?.line">
        <div class="tb-line"><span class="tb-count">{{ fmt(measureResult.line.length, measureResult.units) }}</span>
          <template v-if="measureResult.line.segments.length > 1"> over {{ measureResult.line.segments.length }} segments</template></div>
        <div class="tb-hint">Horizontal {{ fmt(measureResult.line.horizontal, measureResult.units) }} ·
          height change {{ fmt(measureResult.line.vertical, measureResult.units) }}</div>
      </template>
      <template v-else-if="measureResult?.area">
        <div class="tb-line"><span class="tb-count">{{ fmt(measureResult.area.area, measureResult.units, 2) }}</span> surface area</div>
        <div class="tb-hint">Footprint {{ fmt(measureResult.area.footprint, measureResult.units, 2) }} ·
          perimeter {{ fmt(measureResult.area.perimeter, measureResult.units) }}
          <template v-if="measureResult.area.planarity > 0.02 * measureResult.area.perimeter"> · the outline is far from flat</template></div>
      </template>
      <div v-else class="tb-hint">
        Click on a cloud or mesh to place points{{ measureTool === 'distance' ? '' : ' · Enter or double-click finishes' }} · Backspace undoes · Esc exits
      </div>
      <div v-if="measureNote" class="tb-hint warn">{{ measureNote }}</div>
      <div v-if="measureResult" class="tb-row">
        <button class="tb-textbtn" :disabled="!measureDone" title="Keep this measurement with the project" @click="saveMeasure">Save</button>
        <button v-if="!measureDone && measureTool !== 'distance'" class="tb-textbtn" @click="finishMeasure">Finish</button>
        <button class="tb-textbtn" title="Start again (Esc)" @click="clearMeasure">Clear</button>
      </div>
      <template v-if="saved3d.length">
        <div class="tb-hint">Saved</div>
        <div v-for="r in saved3d" :key="r.id" class="tb-line saved-measure">
          <span :title="r.cloudName ? `Measured on ${r.cloudName}` : ''">{{ r.name }}</span>
          <span>{{ savedValue(r) }}<template v-if="savedStale(r)"> · layer changed</template></span>
          <button class="tb-textbtn danger" :aria-label="`Delete ${r.name}`" @click="measurementsStore.remove(r.id)">×</button>
        </div>
      </template>
    </FloatingToolbox>

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
        <div class="tb-row">
          <select v-model.number="assignClass" class="tb-input assign-class" aria-label="Class to assign">
            <option v-for="[c, label] in ASSIGN_CLASSES" :key="c" :value="c">{{ c }} · {{ label }}</option>
          </select>
          <button class="tb-textbtn" title="Set the selected points to this LAS class" @click="commitSelection(false, assignClass)">Assign class</button>
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

/* 3D measuring toolbox. */
.tb-textbtn.active { background: rgba(14, 99, 156, 0.25); border-color: var(--accent); }
.tb-hint.warn { color: #e0a040; margin-top: 4px; }
.saved-measure { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; margin: 2px 0 0; }
.assign-class { flex: 1; width: auto; }
.saved-measure span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
