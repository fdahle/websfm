<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const props = defineProps({
  theme: { type: String, default: 'dark' },
  // Source images ({ uuid, url, … }) — used to texture camera-frustum thumbnails.
  images: { type: Array, default: () => [] },
  showCameras: { type: Boolean, default: true },
  showGraticule: { type: Boolean, default: true },
})

const container = ref(null)
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

// Reconstruction scene objects (replaced on each setReconstructionData call)
let pointCloud = null
const frustumGroup = new THREE.Group()
// Thumbnail textures live as long as their frustum; tracked so we can dispose
// them when the scene is rebuilt (frustumGroup.clear() drops the meshes but not
// the GPU textures they reference).
let thumbTextures = []

// Bounding sphere of the loaded scene — drives the camera view presets.
const sceneCenter = new THREE.Vector3(0, 0, 0)
let sceneRadius = 5

// ── View options (ephemeral, session-scoped display tweaks) ───────────────────
// Live in a viewer-local popover, deliberately NOT in the ribbon or global
// Settings: these are transient per-view knobs, not commands or persisted prefs.
const showOptions = ref(false)
const cameraScale = ref(1)   // multiplier on the auto frustum size
const pointSize = ref(3)     // point-cloud dot size (px, no size attenuation)
// Cached frustum inputs so a cameraScale change can rebuild frustums cheaply
// without recomputing the whole cloud.
let lastCams = []
let lastBaseDepth = 0.15

const BG = { dark: 0x1a1a1a, light: 0xf0f0f0 }
const GRID = {
  dark:  [0x444444, 0x2a2a2a],
  light: [0xb8b8b8, 0xd8d8d8],
}

function makeGrid(t) {
  const [mc, gc] = GRID[t] ?? GRID.dark
  const g = new THREE.GridHelper(10, 10, mc, gc)
  // GridHelper lies in the XZ plane (three.js is Y-up); our scenes are Z-up, so
  // rotate it onto the XY plane to act as the ground graticule.
  g.rotation.x = Math.PI / 2
  g.visible = props.showGraticule
  return g
}

function init() {
  const el = container.value
  const w = el.clientWidth, h = el.clientHeight

  scene = new THREE.Scene()
  scene.background = new THREE.Color(BG[props.theme] ?? BG.dark)

  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 10000)
  // Z-up scene (elevation along +Z, matching the SfM/geospatial convention).
  camera.up.set(0, 0, 1)
  camera.position.set(3, -3, 2.5)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  grid = makeGrid(props.theme)
  scene.add(grid)
  frustumGroup.visible = props.showCameras
  scene.add(frustumGroup)

  const dir = new THREE.DirectionalLight(0xffffff, 2)
  dir.position.set(5, 10, 7)
  scene.add(dir)
  scene.add(new THREE.AmbientLight(0xffffff, 0.4))

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.update()

  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(el)

  animate()
}

// ── Reconstruction visualisation ─────────────────────────────────────────────

// cameras: Map<uuid, { R, t, K }>   points3d: [{ x, y, z }]
function setReconstructionData(cameras, points3d) {
  if (!scene) return

  // Was a model already loaded? If so we keep the current camera framing when the
  // data is swapped (e.g. sparse ↔ dense of the same scene) rather than snapping
  // back to the default view on every selection.
  const hadContent = pointCloud !== null || frustumGroup.children.length > 0

  // Remove previous
  if (pointCloud) { scene.remove(pointCloud); pointCloud.geometry.dispose(); pointCloud = null }
  frustumGroup.clear()
  for (const tex of thumbTextures) tex.dispose()
  thumbTextures = []

  if (points3d.length === 0 && cameras.size === 0) {
    sceneCenter.set(0, 0, 0)
    sceneRadius = 5
    return
  }

  // ── Point cloud ────────────────────────────────────────────────────────────
  if (points3d.length > 0) {
    const positions = new Float32Array(points3d.length * 3)
    // Per-point RGB sampled from the source images (median over each track). Fall
    // back to the flat blue when a point has no colour (e.g. a restored model from
    // before colouring, or keypoints detected without colour).
    const hasColor = points3d.some((p) => p.color)
    const colors = hasColor ? new Float32Array(points3d.length * 3) : null
    for (let i = 0; i < points3d.length; i++) {
      positions[i*3]   = points3d[i].x
      positions[i*3+1] = points3d[i].y
      positions[i*3+2] = points3d[i].z
      if (colors) {
        const c = points3d[i].color
        if (c) { colors[i*3] = c[0]/255; colors[i*3+1] = c[1]/255; colors[i*3+2] = c[2]/255 }
        else   { colors[i*3] = 0.27; colors[i*3+1] = 0.67; colors[i*3+2] = 1.0 } // 0x44aaff
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeBoundingSphere()

    const mat = new THREE.PointsMaterial(
      colors
        ? { size: pointSize.value, sizeAttenuation: false, vertexColors: true }
        : { size: pointSize.value, sizeAttenuation: false, color: 0x44aaff },
    )
    pointCloud = new THREE.Points(geo, mat)
    scene.add(pointCloud)

    // Fit camera to bounding sphere
    const sphere = geo.boundingSphere
    if (sphere) {
      const r = sphere.radius || 1
      sceneCenter.copy(sphere.center)
      sceneRadius = r
      camera.near = r * 0.001
      camera.far  = r * 100
      camera.updateProjectionMatrix()
      // Only auto-frame the very first model; swapping between clouds of an
      // already-loaded scene leaves the user's viewpoint untouched.
      if (!hadContent) resetView()
    }
  }

  // ── Camera frustums ────────────────────────────────────────────────────────
  // Precompute all camera centres (C = -Rᵀt) so the frustum size can be derived
  // from camera spacing rather than point-cloud extent (see cameraFrustumDepth).
  const cams = []
  for (const [uuid, cam] of cameras) {
    const { R, t } = cam
    cams.push({
      uuid, R,
      centre: new THREE.Vector3(
        -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2]),
        -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2]),
        -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2]),
      ),
    })
  }
  // Cache inputs so the "Camera size" slider can rebuild frustums without
  // recomputing the cloud (see the cameraScale watcher).
  lastCams = cams
  lastBaseDepth = cameraFrustumDepth(cams.map((c) => c.centre), points3d)
  buildFrustums(lastCams, lastBaseDepth * cameraScale.value)
}

// (Re)build the camera-frustum lines + image-thumbnail quads at the given depth.
// Rebuilds from scratch (disposing old thumbnail textures) so it's safe to call
// on every cameraScale change.
function buildFrustums(cams, frustumDepth) {
  frustumGroup.clear()
  for (const tex of thumbTextures) tex.dispose()
  thumbTextures = []

  const frustumMat = new THREE.LineBasicMaterial({ color: 0xff8844 })
  const urlByUuid = new Map(props.images.map((im) => [im.uuid, im.url]))
  const texLoader = new THREE.TextureLoader()

  for (const { uuid, R, centre } of cams) {
    const cx = centre.x, cy = centre.y, cz = centre.z

    // Four corners of a unit frustum in camera space, projected to world
    const hw = 0.5 * frustumDepth  // half-width at depth
    const corners = [[-hw,-hw,frustumDepth],[hw,-hw,frustumDepth],[hw,hw,frustumDepth],[-hw,hw,frustumDepth]]
    const worldCorners = corners.map(([lx,ly,lz]) => {
      return new THREE.Vector3(
        R[0][0]*lx + R[1][0]*ly + R[2][0]*lz + cx,
        R[0][1]*lx + R[1][1]*ly + R[2][1]*lz + cy,
        R[0][2]*lx + R[1][2]*ly + R[2][2]*lz + cz,
      )
    })

    // 5 lines: 4 edges from centre to corners + 1 box closing the face
    const verts = []
    for (const c of worldCorners) { verts.push(centre.x, centre.y, centre.z, c.x, c.y, c.z) }
    // Close rectangle
    for (let i = 0; i < 4; i++) {
      const a = worldCorners[i], b = worldCorners[(i+1)%4]
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    frustumGroup.add(new THREE.LineSegments(geo, frustumMat))

    // Thumbnail: a small textured quad on the frustum's far face (image plane).
    // worldCorners is [BL-in-image, BR, TR, TL] in camera x-right / y-down space,
    // so map UVs with the texture's top row (v=1) to the y=-hw corners.
    const url = urlByUuid.get(uuid)
    if (url) {
      const [c0, c1, c2, c3] = worldCorners
      const planeGeo = new THREE.BufferGeometry()
      planeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        c0.x, c0.y, c0.z,  c1.x, c1.y, c1.z,  c2.x, c2.y, c2.z,  c3.x, c3.y, c3.z,
      ]), 3))
      planeGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 1,  1, 1,  1, 0,  0, 0,
      ]), 2))
      planeGeo.setIndex([0, 1, 2, 0, 2, 3])
      const tex = texLoader.load(url)
      tex.colorSpace = THREE.SRGBColorSpace
      thumbTextures.push(tex)
      const planeMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
      frustumGroup.add(new THREE.Mesh(planeGeo, planeMat))
    }
  }
}

function clearReconstructionData() {
  setReconstructionData(new Map(), [])
}

// ── Camera view presets ──────────────────────────────────────────────────────
// Scenes are Z-up (elevation along +Z): Top/Bottom look down the vertical Z axis,
// while Front/Back/Left/Right are the horizontal side views. Place the camera
// along the chosen axis, looking at the scene centre, framing the bounding sphere.
const VIEW_OFFSETS = {
  top:    [0,  0,  1],
  bottom: [0,  0, -1],
  front:  [0, -1,  0],
  back:   [0,  1,  0],
  left:   [-1, 0,  0],
  right:  [1,  0,  0],
}

function setView(dir) {
  if (!camera || !controls) return
  const o = VIEW_OFFSETS[dir] || VIEW_OFFSETS.front
  const d = sceneRadius * 2.5
  // For top/bottom the view direction is parallel to the up axis (Z), so pick an
  // in-plane up (Y) to avoid OrbitControls gimbal-locking.
  if (dir === 'top' || dir === 'bottom') camera.up.set(0, 1, 0)
  else                                   camera.up.set(0, 0, 1)
  controls.target.copy(sceneCenter)
  camera.position.set(
    sceneCenter.x + o[0] * d,
    sceneCenter.y + o[1] * d,
    sceneCenter.z + o[2] * d,
  )
  camera.updateProjectionMatrix()
  controls.update()
}

function resetView() {
  if (!camera || !controls) return
  camera.up.set(0, 0, 1)
  controls.target.copy(sceneCenter)
  camera.position.set(
    sceneCenter.x + sceneRadius * 1.8,
    sceneCenter.y - sceneRadius * 1.8,
    sceneCenter.z + sceneRadius * 1.4,
  )
  camera.updateProjectionMatrix()
  controls.update()
}

defineExpose({ setReconstructionData, clearReconstructionData, setView, resetView })

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
  renderer.render(scene, camera)
}

watch(() => props.theme, (t) => {
  if (!scene) return
  scene.background = new THREE.Color(BG[t] ?? BG.dark)
  scene.remove(grid)
  grid = makeGrid(t)
  scene.add(grid)
})

watch(() => props.showCameras, (v) => { if (frustumGroup) frustumGroup.visible = v })
watch(() => props.showGraticule, (v) => { if (grid) grid.visible = v })

// View-options sliders — cheap live updates, no cloud recompute.
watch(cameraScale, () => { if (lastCams.length) buildFrustums(lastCams, lastBaseDepth * cameraScale.value) })
watch(pointSize, (v) => { if (pointCloud) pointCloud.material.size = v })

onMounted(init)

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  resizeObserver?.disconnect()
  for (const tex of thumbTextures) tex.dispose()
  thumbTextures = []
  controls?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div ref="container" class="viewer">
    <div class="overlay">three.js viewer</div>

    <!-- Viewer-local view options popover (ephemeral display tweaks) -->
    <div class="view-options">
      <button
        class="vo-btn"
        :class="{ active: showOptions }"
        title="View options"
        @click="showOptions = !showOptions"
      >⚙</button>
      <div v-if="showOptions" class="vo-panel">
        <div class="vo-title">View options</div>
        <label class="vo-row">
          <span>Camera size</span>
          <input type="range" min="0.2" max="3" step="0.1" v-model.number="cameraScale" />
          <span class="vo-val">{{ cameraScale.toFixed(1) }}×</span>
        </label>
        <label class="vo-row">
          <span>Point size</span>
          <input type="range" min="1" max="8" step="1" v-model.number="pointSize" />
          <span class="vo-val">{{ pointSize }}</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
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

.view-options {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.vo-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  line-height: 1;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  cursor: pointer;
}
.vo-btn:hover,
.vo-btn.active {
  background: var(--hover-bg);
}

.vo-panel {
  min-width: 210px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  color: var(--text);
  user-select: none;
}

.vo-title {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-dim);
}

.vo-row {
  display: grid;
  grid-template-columns: 74px 1fr 34px;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.vo-row input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}
.vo-val {
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
</style>
