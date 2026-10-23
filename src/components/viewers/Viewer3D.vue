<script setup>
import { relativePositions } from '../../core/products/pointView.ts'
import { MAX_BUFFER_BYTES } from '../../core/bufferLimit.js'
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { useViewerSettings } from '../../composables/useViewerSettings.js'
import { estimateUpFromCameras } from '../../core/sfm/geometry.js'
import CloudLegend from './CloudLegend.vue'
import FloatingToolbox from './FloatingToolbox.vue'
import FieldHelp from '../guide/FieldHelp.vue'
import { TURNTABLE_DEFAULTS } from '../../core/defaults.user.js'
import { TURNTABLE_TUNING } from '../../core/tuning.js'
import {
  buildCloudStyle,
  scalarRange,
  sharedElevationRange,
  resolveCloudStyle,
} from '../../core/products/cloudStyle.js'
import { viewerClipping } from '../../core/products/viewerClipping.js'
import { pickNearestPoint } from '../../core/products/screenPick.js'
import { settleEditLatch } from '../../core/products/editFraming.js'
import { viewerMayHandleKey } from '../../utils/keyRouting.js'
import { texturePageBlobs } from '../../stores/reconstruction/meshTexture.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { createLodLayer, LOD_VIEW_MIN } from './lodLayer.js'
import { robustBounds } from './viewerFraming.js'
import {
  srgbVertexColors,
  disposeMaterial,
  disposeObject,
  disposeLayer,
  releaseStyleBuffers,
} from './threeResources.js'
import { useCameraFrustums } from './useCameraFrustums.js'
import { useCloudSelection } from './useCloudSelection.js'
import { useMeasure3d } from './useMeasure3d.js'
import { useRegionGizmo } from './useRegionGizmo.js'
import { useTurntable } from './useTurntable.js'

// pointSize is set from the ribbon's View ▸ Scene steppers.
const { gridZ, background, nearClip, pointSize, pointBudget } = useViewerSettings()

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
  // Drawn grey and dim when the saved region no longer matches the model.
  regionStale: { type: Boolean, default: false },
  // The Region toolbox is open: the box gets drag handles, and a drag emits
  // `region-change` with the new { min, max } (the draft; Apply stores it).
  regionEdit: { type: Boolean, default: false },
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
// toggles can show it — the same up-reporting raster measuring uses. `turntable`
// reports the turntable on or off, for View ▸ Camera ▸ Turntable.
const emit = defineEmits([
  'command',
  'edit-selection',
  'select-tool',
  'pick',
  'measure-tool',
  'region-change',
  'turntable',
])

const container = ref(null)
// Set when WebGL is unavailable (headless/sandboxed/GPU-disabled). We degrade to an
// overlay instead of throwing out of the mounted hook, which would crash app mount and
// take the whole UI down with the 3D view.
const glError = ref('')
let renderer, scene, camera, controls, animationId, resizeObserver, grid

// Independent cloud layers and shared camera frustums
const cloudLayers = new Map()
const legendLayers = ref([])
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
        const w = Math.floor(bmp.width * s),
          h = Math.floor(bmp.height * s)
        bmp.close()
        bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
      }
      if (unmounted || layer.pageMaterials !== mats) {
        bmp.close()
        return
      }
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

// Robust bounds of the loaded scene — drive the camera view presets and grid.
const sceneCenter = new THREE.Vector3(0, 0, 0)
let sceneRadius = 5
// Estimated scene up (unit); orients the initial view + grid so the model reads
// level without georeferencing (see estimateUpFromCameras). Default world +Z.
const sceneUp = new THREE.Vector3(0, 0, 1)
// Signed extent of the cloud/mesh *along sceneUp*, relative to sceneCenter — drives
// the grid's min/avg/max placement (see updateGrid). 0 until a cloud loads.
let sceneAlongMin = 0,
  sceneAlongMax = 0

// The parts of the view that live in their own modules. They read the renderer state
// through `view`, live: the renderer, scene and camera exist only after init().
const view = {
  get renderer() {
    return renderer
  },
  get scene() {
    return scene
  },
  get camera() {
    return camera
  },
  get unmounted() {
    return unmounted
  },
}
const {
  frustumGroup,
  setCameras,
  afterFrame: frustumsAfterFrame,
  dispose: disposeFrustums,
} = useCameraFrustums({
  view,
  images: () => props.images,
  requestRender,
})
const {
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
  // Not used here: kept on the component so the browser tests can draw a shape.
  applySelectionShape,
} = useCloudSelection({
  view,
  container,
  cloudLayers,
  pointerPx,
  requestRender,
  emit,
  onEditPending: (ids) => {
    editPendingIds = ids
  },
})
// How close to the pointer (px) a pick lands, for point picking and 3D measuring.
const PICK_RADIUS_PX = 8
const {
  measureTool,
  measurePts,
  measureDone,
  measureNote,
  measureResult,
  saved3d,
  measurementsStore,
  fmt,
  toggleMeasureTool,
  exitMeasure,
  clearMeasure,
  measureClick,
  finishMeasure,
  undoMeasure,
  savedValue,
  savedStale,
  saveMeasure,
} = useMeasure3d({
  view,
  props,
  container,
  cloudLayers,
  sceneUp,
  pointerPx,
  pickRadiusPx: PICK_RADIUS_PX,
  requestRender,
  emit,
  selectTool,
  exitSelection,
})
const { regionHover, updateRegionBox, onRegionPointerDown, onRegionPointerMove, onRegionPointerUp, abortRegionDrag } =
  useRegionGizmo({
    view,
    props,
    container,
    pointerPx,
    requestRender,
    emit,
    otherToolActive: () => !!selectTool.value || !!measureTool.value || !!props.pickMode,
  })
const {
  turntableOn,
  turntableSeconds,
  setTurntableSeconds,
  recording,
  recordProgress,
  recordError,
  setTurntable,
  toggleTurntable,
  stepTurntable,
  recordTurn,
  stopRecording,
} = useTurntable({
  view,
  controls: () => controls,
  alignUp: alignUpToScene,
  container,
  requestRender,
  emit,
})

const BG = { dark: 0x1a1a1a, light: 0xf0f0f0, black: 0x000000 }
function backgroundColor() {
  const key = background.value === 'theme' ? props.theme : background.value
  return BG[key] ?? BG.dark
}
const GRID = {
  dark: [0x444444, 0x2a2a2a],
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
  const off =
    gridZ.value === 'min'
      ? sceneAlongMin
      : gridZ.value === 'max'
        ? sceneAlongMax
        : 0.5 * (sceneAlongMin + sceneAlongMax) // 'avg' → middle of the extent
  grid.position.copy(sceneCenter).addScaledVector(sceneUp, off)
}

function init() {
  const el = container.value
  const w = el.clientWidth,
    h = el.clientHeight

  // Create the WebGL renderer FIRST: if the context can't be created (sandboxed /
  // GPU-disabled / headless), the constructor throws — catch it and bail before any
  // scene/camera/controls exist, so every `if (!scene)` guard below and in the watchers
  // keeps the component inert rather than half-initialised.
  try {
    // Survey extents and close-up inspection span many orders of magnitude.
    // Log depth avoids the poor far-surface precision of a tiny near plane.
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
  } catch (e) {
    // three.js has already logged the GL details to the console; this is the reader's version.
    glError.value =
      'The 3D view is unavailable: this browser or environment could not ' +
      'create a WebGL context. This often happens over Remote Desktop, or when hardware ' +
      'acceleration is turned off in the browser settings. The rest of the app is unaffected.'
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
// A cloud past 178 M points (its positions in shared memory, core/bigArray.js) cannot be
// drawn whole: the GPU copy would be one Float32 buffer over the browser's 2 GiB. It is
// drawn through its octree only, and not at all until the octree is built.
const tooLargeToDrawWhole = (cloud) => cloud.kind === 'dense' && 12 * (cloud.count ?? 0) > MAX_BUFFER_BYTES
const usesLod = (cloud) =>
  cloud.kind === 'dense' &&
  !!cloud.lod &&
  (!cloud.pos || tooLargeToDrawWhole(cloud) || (cloud.count >= LOD_VIEW_MIN && !needsAllPoints()))
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
        updateLayerBounds()
        updateGrid()
      }
      requestRender()
    },
  })
  layer.bounds = layerBounds(layer)
  scene.add(layer.object)
  return layer
}
const layerBounds = (layer) =>
  layer.lod ? layer.boundsFor(sceneUp, robustBounds) : robustBounds(layer.positions, layer.count, sceneUp)

function createCloudLayer(cloud) {
  if (usesLod(cloud)) return createLodCloudLayer(cloud)
  if (tooLargeToDrawWhole(cloud)) return null
  const isMesh = cloud.kind === 'mesh'
  const count = isMesh ? cloud.nVerts : (cloud.count ?? cloud.points?.length ?? 0)
  if (!count || (!cloud.pos && !cloud.points)) return null
  // A sparse cloud's positions are its SparsePoints pos column (read, never written).
  const positions = cloud.pos ?? cloud.points.pos
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
  return {
    object,
    baseMaterial: material,
    positions,
    count,
    source: cloud,
    bounds: robustBounds(positions, count, sceneUp),
  }
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
    ? visual.colors instanceof Uint8Array
      ? visual.colors
      : Uint8Array.from(visual.colors)
    : null
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
    sceneCenter.set(0, 0, 0)
    sceneRadius = 5
    sceneAlongMin = 0
    sceneAlongMax = 0
    return
  }
  const box = new THREE.Box3()
  let low = Infinity,
    high = -Infinity
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
// `follow`: the layers are a model still growing (the live view of a running sparse
// reconstruction); the view is refitted whenever it has outgrown the last fit.
let fittedRadius = 0
function setCloudLayers(clouds, { follow = false } = {}) {
  lastClouds = clouds
  if (!scene) return
  const hadContent = cloudLayers.size > 0 || frustumGroup.children.length > 0
  const addedCloud = clouds.some((c) => c.visible !== false && !knownCloudIds.has(c.id))
  // Read against the layers as last drawn, before this update reconciles them.
  const edit = settleEditLatch(editPendingIds, clouds, (id) => cloudLayers.get(id)?.source, addedCloud)
  editPendingIds = edit.pending
  knownCloudIds = new Set(clouds.map((c) => c.id))
  const visible = clouds.filter((c) => c.visible !== false)
  const elevationRange = sharedElevationRange(clouds, cachedElevationRange)
  const ids = new Set(visible.map((c) => c.id))
  for (const [id, layer] of cloudLayers) {
    if (!ids.has(id)) {
      scene.remove(layer.object)
      disposeLayer(layer)
      cloudLayers.delete(id)
    }
  }
  const cameraMaps = visible.map((c) => c.cameras).filter(Boolean)
  const camerasChanged =
    cameraMaps.length !== lastCameraMaps.length || cameraMaps.some((m, i) => m !== lastCameraMaps[i])
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
    if (
      layer &&
      (layer.source.pos !== cloud.pos ||
        layer.source.points !== cloud.points ||
        layer.source.idx !== cloud.idx ||
        layer.source.uv !== cloud.uv ||
        layer.source.count !== cloud.count ||
        layer.source.kind !== cloud.kind ||
        !!layer.lod !== usesLod(cloud) ||
        (layer.lod && layer.source.lod !== cloud.lod))
    ) {
      scene.remove(layer.object)
      disposeLayer(layer)
      cloudLayers.delete(cloud.id)
      layer = null
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
    if (
      !layer.legend ||
      layer.style !== cloud.style ||
      layer.source.col !== cloud.col ||
      layer.source.attributes !== cloud.attributes ||
      layer.elevationRangeKey !== rangeKey
    )
      styleLayer(layer, cloud, sharedRange)
    layer.source = cloud
  }
  legendLayers.value = [...cloudLayers].map(([id, layer]) => ({ id, name: layer.source.name, legend: layer.legend }))
  updateLayerBounds()
  updateGrid()
  if (camerasChanged) {
    lastCameraMaps = cameraMaps
    setCameras(cameras)
  }
  // Fit newly added layers together, including distant survey tiles. Selection,
  // symbology and visibility toggles preserve the user's camera position.
  const fit = (!hadContent || (addedCloud && !edit.editResult)) && cloudLayers.size
  // An up estimated from more cameras turns the grid: refit, or the view is left tilted.
  const outgrown = follow && cloudLayers.size && (sceneRadius > 1.3 * fittedRadius || upChanged)
  if (fit || outgrown) {
    resetView()
    fittedRadius = sceneRadius
  }
  updateClipping()
  pruneSelections()
  requestRender()
}

function zoomToCloud(id) {
  const layer = cloudLayers.get(id)
  if (!layer) return
  const center = sceneCenter.clone(),
    radius = sceneRadius
  sceneCenter.copy(layer.bounds.center)
  sceneRadius = layer.bounds.radius
  resetView()
  sceneCenter.copy(center)
  sceneRadius = radius
  updateClipping()
  requestRender()
}

function updateClipping() {
  if (!camera || !controls) return
  const { near, far } = viewerClipping(sceneRadius, camera.position.distanceTo(controls.target), nearClip.value)
  if (Math.abs(camera.near - near) > near * 0.01 || Math.abs(camera.far - far) > far * 0.01) {
    camera.near = near
    camera.far = far
    camera.updateProjectionMatrix()
  }
}

function clearReconstructionData() {
  setCloudLayers([])
}

watch([() => !!selectTool.value, () => !!props.pickMode], () => setCloudLayers(lastClouds))

function pointerPx(e) {
  const r = container.value.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top]
}
// Keys reach this before App's global handler (see utils/keyRouting): nothing is
// done while a dialog is open or a field has focus, and a key acted on is consumed
// so App does not also close a modal or leave the active 3D tool on the same press.
function onSelectKey(e) {
  if (!container.value?.offsetParent) return // tab hidden (v-show)
  if (!viewerMayHandleKey(e)) return
  if (e.key === 'Escape' && abortRegionDrag()) {
    e.preventDefault()
    return
  }
  if (measureTool.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (measurePts.value.length) clearMeasure()
      else exitMeasure()
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      undoMeasure()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      finishMeasure()
      return
    }
  }
  if (e.key === 'Escape' && abortStroke()) {
    e.preventDefault()
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

// The turntable turns about the scene's up axis, which needs the camera's up on it:
// the Top and Bottom presets tilt it into the ground plane.
function alignUpToScene() {
  if (!camera || camera.up.angleTo(sceneUp) < 1e-6) return
  camera.up.copy(sceneUp)
  syncControlsUp()
}

function setView(dir) {
  if (!camera || !controls) return
  const { up, right, fwd } = upBasis()
  const d = sceneRadius * 2.5
  let dirVec, camUp
  switch (dir) {
    // Top/bottom look along the up axis, so use an in-plane up (fwd) to avoid
    // OrbitControls gimbal-locking.
    case 'top':
      dirVec = up.clone()
      camUp = fwd.clone()
      break
    case 'bottom':
      dirVec = up.clone().negate()
      camUp = fwd.clone()
      break
    case 'back':
      dirVec = fwd.clone()
      camUp = up.clone()
      break
    case 'left':
      dirVec = right.clone().negate()
      camUp = up.clone()
      break
    case 'right':
      dirVec = right.clone()
      camUp = up.clone()
      break
    case 'front':
    default:
      dirVec = fwd.clone().negate()
      camUp = up.clone()
      break
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
  camera.position
    .copy(sceneCenter)
    .addScaledVector(fwd, -sceneRadius * 1.8)
    .addScaledVector(right, sceneRadius * 1.2)
    .addScaledVector(up, sceneRadius * 1.2)
  camera.updateProjectionMatrix()
  controls.update()
  requestRender()
}

// Leave selecting and measuring (a run's live view keeps orbit and zoom only).
function exitTools() {
  exitSelection()
  exitMeasure()
}

defineExpose({
  setCloudLayers,
  clearReconstructionData,
  setView,
  resetView,
  zoomToCloud,
  toggleSelectTool,
  toggleMeasureTool,
  exitTools,
  toggleTurntable,
})

function onResize() {
  const el = container.value
  if (!el || !renderer) return
  const w = el.clientWidth,
    h = el.clientHeight
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
  // The turntable turns the camera first, and keeps frames coming while it runs.
  const turning = stepTurntable(performance.now())
  // Damping: update() keeps moving the camera for a while after the gesture ends and
  // returns true while it does; its 'change' event re-requests the next frame.
  controls.update()
  updateClipping()
  // Level-of-detail layers choose their nodes for this view (and fetch missing ones).
  for (const layer of cloudLayers.values()) {
    if (layer.lod && layer.object.visible)
      layer.update(camera, renderer.domElement.clientHeight || 1, pointBudget.value * 1e6)
  }
  renderer.render(scene, camera)
  frustumsAfterFrame()
  if (turning) requestRender()
}

watch(
  () => props.theme,
  (t) => {
    if (!scene) return
    scene.background = new THREE.Color(backgroundColor())
    scene.remove(grid)
    disposeObject(grid)
    grid = makeGrid(t)
    updateGrid()
    scene.add(grid)
    requestRender()
  },
)

watch(background, () => {
  if (scene) scene.background = new THREE.Color(backgroundColor())
  requestRender()
})

watch(
  () => props.showCameras,
  (v) => {
    if (frustumGroup) frustumGroup.visible = v
    requestRender()
  },
)
watch(
  () => props.showGrid,
  (v) => {
    if (grid) grid.visible = v
    requestRender()
  },
)
watch(gridZ, () => {
  updateGrid()
  requestRender()
})
// The reconstruction's up estimate can arrive/refine after content is already shown
// (e.g. a dense cloud selected before the sparse cameras are pushed). Re-orient the
// grid to it without yanking the user's current viewpoint.
watch(
  () => props.sceneUp,
  (u) => {
    if (u && u.length === 3) {
      sceneUp.set(u[0], u[1], u[2]).normalize()
      for (const layer of cloudLayers.values()) layer.bounds = layerBounds(layer)
      updateLayerBounds()
      updateGrid()
      requestRender()
    }
  },
)

// ── Point picking (tool-driven) ───────────────────────────────────────────────
// While `pickMode` is set, a click WITHOUT a drag (a drag still orbits) picks the
// drawn point nearest the camera within a few pixels (core/products/screenPick.js,
// on the Float32 render buffer and the matrix that drew it) and emits its EXACT
// Float64 source coordinates: { cloudId, index, position:[x,y,z] }.
let pickDown = null
function onPickPointerDown(e) {
  if ((!props.pickMode && !measureTool.value) || e.button !== 0 || !renderer || e.target !== renderer.domElement) {
    pickDown = null
    return
  }
  pickDown = { x: e.clientX, y: e.clientY }
}
function onPickPointerUp(e) {
  const down = pickDown
  pickDown = null
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
  if (!props.pickMode) {
    if (measureTool.value) measureClick(e)
    return
  }
  const [px, py] = pointerPx(e)
  const w = container.value.clientWidth,
    h = container.value.clientHeight
  const x = (px / w) * 2 - 1,
    y = 1 - (py / h) * 2
  const tolX = (2 * PICK_RADIUS_PX) / w,
    tolY = (2 * PICK_RADIUS_PX) / h
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
    const hit = pickNearestPoint(geometry.getAttribute('position').array, layer.count, {
      matrix,
      x,
      y,
      tolX,
      tolY,
      indices,
    })
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
  if (markerObject) {
    scene?.remove(markerObject)
    disposeObject(markerObject)
    markerObject = null
  }
  requestRender()
  if (!scene || !markers?.length) return
  const o = markers[0].position
  const pos = new Float32Array(markers.length * 3),
    col = new Float32Array(markers.length * 3)
  markers.forEach((m, k) => {
    pos[k * 3] = m.position[0] - o[0]
    pos[k * 3 + 1] = m.position[1] - o[1]
    pos[k * 3 + 2] = m.position[2] - o[2]
    const c = new THREE.Color(m.color || '#ffb020')
    col[k * 3] = c.r
    col[k * 3 + 1] = c.g
    col[k * 3 + 2] = c.b
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const material = new THREE.PointsMaterial({
    size: 11,
    sizeAttenuation: false,
    vertexColors: true,
    depthTest: false,
    transparent: true,
  })
  markerObject = new THREE.Points(geometry, material)
  markerObject.position.set(o[0], o[1], o[2])
  markerObject.renderOrder = 12
  scene.add(markerObject)
}
watch(() => props.markers, updateMarkers, { deep: true })

watch(pointSize, (v) => {
  for (const layer of cloudLayers.values()) {
    if (layer.lod) layer.baseMaterial.size = v
    else if (layer.object.isPoints) layer.object.material.size = v
  }
  setOverlaySize(v)
  requestRender()
})
watch(nearClip, () => {
  updateClipping()
  requestRender()
})
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
  window.removeEventListener('keydown', onSelectKey)
  clearSelection()
  resizeObserver?.disconnect()
  disposeFrustums()
  for (const layer of cloudLayers.values()) disposeLayer(layer)
  cloudLayers.clear()
  if (grid) {
    disposeObject(grid)
    grid = null
  }
  controls?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div
    ref="container"
    class="viewer"
    :class="{ 'selecting': !!selectTool || !!pickMode || !!measureTool, 'region-handle': !!regionHover }"
    @contextmenu.prevent
    @dblclick="measureTool && finishMeasure()"
    @pointerdown.capture="
      (e) => {
        onRegionPointerDown(e)
        onPickPointerDown(e)
        onSelectPointerDown(e)
      }
    "
    @pointermove="
      (e) => {
        onRegionPointerMove(e)
        onSelectPointerMove(e)
      }
    "
    @pointerup="
      (e) => {
        onRegionPointerUp(e)
        onSelectPointerUp(e)
        onPickPointerUp(e)
      }
    "
    @pointercancel="
      (e) => {
        onRegionPointerUp(e)
        onSelectPointerUp(e)
      }
    "
  >
    <!-- WebGL unavailable: degrade gracefully instead of crashing app mount. -->
    <div v-if="glError" class="gl-error">
      <div class="gl-error-box">{{ glError }}</div>
    </div>

    <CloudLegend v-if="showLegend" :layers="legendLayers" />

    <svg v-if="drawShape" class="select-shape" aria-hidden="true">
      <rect
        v-if="drawShape.kind === 'rect'"
        :x="Math.min(drawShape.points[0], drawShape.points[2])"
        :y="Math.min(drawShape.points[1], drawShape.points[3])"
        :width="Math.abs(drawShape.points[2] - drawShape.points[0])"
        :height="Math.abs(drawShape.points[3] - drawShape.points[1])"
      />
      <polygon v-else :points="drawShape.points.join(' ')" />
    </svg>

    <!-- Toolboxes of tools that live outside this component (Region, point-pair
         alignment) render over the 3D view here. -->
    <slot name="toolbox" />

    <!-- 3D measuring (Tools ▸ Measure ▸ Measure in 3D). -->
    <FloatingToolbox
      v-if="measureTool"
      id="measure-3d"
      title="Measure in 3D"
      anchor="top-center"
      :width="300"
      close-title="Stop measuring (Esc)"
      @close="exitMeasure"
    >
      <div class="tb-row" role="group" aria-label="Measure">
        <button
          v-for="t in [
            ['distance', 'Distance'],
            ['polyline', 'Polyline'],
            ['area', 'Area'],
          ]"
          :key="t[0]"
          class="tb-textbtn"
          :class="{ active: measureTool === t[0] }"
          :aria-pressed="measureTool === t[0]"
          @click="
            () => {
              measureTool = t[0]
              clearMeasure()
            }
          "
        >
          {{ t[1] }}
        </button>
      </div>
      <template v-if="measureResult?.line">
        <div class="tb-line">
          <span class="tb-count">{{ fmt(measureResult.line.length, measureResult.units) }}</span>
          <template v-if="measureResult.line.segments.length > 1">
            over {{ measureResult.line.segments.length }} segments</template
          >
        </div>
        <div class="tb-hint">
          Horizontal {{ fmt(measureResult.line.horizontal, measureResult.units) }} · height change
          {{ fmt(measureResult.line.vertical, measureResult.units) }}
        </div>
      </template>
      <template v-else-if="measureResult?.area">
        <div class="tb-line">
          <span class="tb-count">{{ fmt(measureResult.area.area, measureResult.units, 2) }}</span> surface area
        </div>
        <div class="tb-hint">
          Footprint {{ fmt(measureResult.area.footprint, measureResult.units, 2) }} · perimeter
          {{ fmt(measureResult.area.perimeter, measureResult.units) }}
          <template v-if="measureResult.area.planarity > 0.02 * measureResult.area.perimeter">
            · the outline is far from flat</template
          >
        </div>
      </template>
      <div v-else class="tb-hint">
        Click on a cloud or mesh to place points{{
          measureTool === 'distance' ? '' : ' · Enter or double-click finishes'
        }}
        · Backspace undoes · Esc exits
      </div>
      <div v-if="measureNote" class="tb-hint warn">{{ measureNote }}</div>
      <div v-if="measureResult" class="tb-row">
        <button
          class="tb-textbtn"
          :disabled="!measureDone"
          title="Keep this measurement with the project"
          @click="saveMeasure"
        >
          Save
        </button>
        <button v-if="!measureDone && measureTool !== 'distance'" class="tb-textbtn" @click="finishMeasure">
          Finish
        </button>
        <button class="tb-textbtn" title="Start again (Esc)" @click="clearMeasure">Clear</button>
      </div>
      <template v-if="saved3d.length">
        <div class="tb-hint tb-row">
          Saved
          <button
            class="tb-textbtn"
            title="Export these measurements as CSV or GeoJSON"
            @click="
              emit('command', 'export-measurements', {
                ids: saved3d.map((r) => r.id),
                label: `${saved3d.length} 3D measurement${saved3d.length === 1 ? '' : 's'}`,
              })
            "
          >
            Export…
          </button>
        </div>
        <div v-for="r in saved3d" :key="r.id" class="tb-line saved-measure">
          <span :title="r.cloudName ? `Measured on ${r.cloudName}` : ''">{{ r.name }}</span>
          <span>{{ savedValue(r) }}<template v-if="savedStale(r)"> · layer changed</template></span>
          <button class="tb-textbtn danger" :aria-label="`Delete ${r.name}`" @click="measurementsStore.remove(r.id)">
            ×
          </button>
        </div>
      </template>
    </FloatingToolbox>

    <!-- The turntable (View ▸ Camera ▸ Turntable): its speed, and one turn recorded as
         a video. -->
    <FloatingToolbox
      v-if="turntableOn"
      id="turntable-3d"
      title="Turntable"
      :width="236"
      close-title="Stop the turntable"
      @close="setTurntable(false)"
    >
      <label class="tb-field turn-field">
        <FieldHelp
          op="3d-view"
          param="secondsPerTurn"
          :value="turntableSeconds"
          :default-value="TURNTABLE_DEFAULTS.secondsPerTurn"
          >Seconds per turn</FieldHelp
        >
        <input
          type="number"
          class="tb-input"
          :min="TURNTABLE_TUNING.minSecondsPerTurn"
          :max="TURNTABLE_TUNING.maxSecondsPerTurn"
          step="1"
          :value="turntableSeconds"
          :disabled="recording"
          @change="(e) => setTurntableSeconds(e.target.value)"
        />
      </label>
      <div class="tb-row">
        <button
          v-if="!recording"
          class="tb-textbtn"
          title="Save one full turn of the 3D view as a video"
          @click="recordTurn"
        >
          Record one turn
        </button>
        <template v-else>
          <span class="tb-count">Recording {{ Math.round(recordProgress * 100) }} %</span>
          <button class="tb-textbtn" title="Stop and discard the video" @click="stopRecording(false)">Cancel</button>
        </template>
      </div>
      <div v-if="recordError" class="tb-hint warn">{{ recordError }}</div>
      <div v-else class="tb-hint tb-row">
        {{ recording ? 'The view is locked until the turn is done.' : 'Drag to steer; it turns on when you let go.' }}
      </div>
    </FloatingToolbox>

    <!-- The selection tool's toolbox. The ribbon (View ▸ Select) chooses the tool;
         what you do with the selection lives here. -->
    <FloatingToolbox
      v-if="selectTool || selectionCount"
      id="select-3d"
      title="Select points"
      anchor="top-center"
      :width="260"
      close-title="Stop selecting (Esc)"
      @close="exitSelection"
    >
      <template v-if="selectionCount">
        <div class="tb-line">
          <span class="tb-count">{{ selectionCount.toLocaleString() }}</span>
          point{{ selectionCount === 1 ? '' : 's' }} selected<template v-if="selectionClouds > 1">
            in {{ selectionClouds }} clouds</template
          >
        </div>
        <div v-if="selectionStreamed" class="tb-hint tb-row">
          Of the points drawn now: on a streamed cloud the edit takes every point inside the shape, at full detail.
        </div>
        <div class="tb-row">
          <button class="tb-textbtn danger" title="Delete the selected points (Delete)" @click="commitSelection(false)">
            Delete
          </button>
          <button class="tb-textbtn" title="Keep only the selected points" @click="commitSelection(true)">
            Keep only
          </button>
          <button class="tb-textbtn" title="Clear the selection (Esc)" @click="clearSelection">Clear</button>
        </div>
        <div class="tb-row">
          <select v-model.number="assignClass" class="tb-input assign-class" aria-label="Class to assign">
            <option v-for="[c, label] in ASSIGN_CLASSES" :key="c" :value="c">{{ c }} · {{ label }}</option>
          </select>
          <button
            class="tb-textbtn"
            title="Set the selected points to this LAS class"
            @click="commitSelection(false, assignClass)"
          >
            Assign class
          </button>
        </div>
      </template>
      <div v-else class="tb-hint">
        {{
          selectableLayers().length
            ? `Drag a ${selectTool === 'lasso' ? 'lasso' : 'rectangle'} over dense-cloud points · Shift adds · Alt subtracts · Esc exits`
            : 'Show a dense cloud to select its points'
        }}
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
.tb-textbtn.active {
  background: rgba(14, 99, 156, 0.25);
  border-color: var(--accent);
}
.tb-hint.warn {
  color: #e0a040;
  margin-top: 4px;
}
.saved-measure {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 6px;
  align-items: center;
  margin: 2px 0 0;
}
.turn-field {
  grid-template-columns: 1fr 64px;
}
.assign-class {
  flex: 1;
  width: auto;
}
.saved-measure span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.viewer.region-handle :deep(canvas) {
  cursor: move;
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
