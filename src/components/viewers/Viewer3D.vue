<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const props = defineProps({
  theme: { type: String, default: 'dark' },
})

const container = ref(null)
let renderer, scene, camera, controls, animationId, resizeObserver, grid

// Reconstruction scene objects (replaced on each setReconstructionData call)
let pointCloud = null
const frustumGroup = new THREE.Group()

// Bounding sphere of the loaded scene — drives the camera view presets.
const sceneCenter = new THREE.Vector3(0, 0, 0)
let sceneRadius = 5

const BG = { dark: 0x1a1a1a, light: 0xf0f0f0 }
const GRID = {
  dark:  [0x444444, 0x2a2a2a],
  light: [0xb8b8b8, 0xd8d8d8],
}

function makeGrid(t) {
  const [mc, gc] = GRID[t] ?? GRID.dark
  return new THREE.GridHelper(10, 10, mc, gc)
}

function init() {
  const el = container.value
  const w = el.clientWidth, h = el.clientHeight

  scene = new THREE.Scene()
  scene.background = new THREE.Color(BG[props.theme] ?? BG.dark)

  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 10000)
  camera.position.set(2.5, 2, 3)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  grid = makeGrid(props.theme)
  scene.add(grid)
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

  // Remove previous
  if (pointCloud) { scene.remove(pointCloud); pointCloud.geometry.dispose() }
  frustumGroup.clear()

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
        ? { size: 3, sizeAttenuation: false, vertexColors: true }
        : { size: 3, sizeAttenuation: false, color: 0x44aaff },
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
      resetView()
    }
  }

  // ── Camera frustums ────────────────────────────────────────────────────────
  // Estimate scene scale from bounding sphere radius (fallback = 1)
  const sceneScale = pointCloud?.geometry.boundingSphere?.radius ?? 1
  const frustumDepth = sceneScale * 0.15

  const frustumMat = new THREE.LineBasicMaterial({ color: 0xff8844 })

  for (const [, cam] of cameras) {
    const { R, t } = cam
    // Camera centre in world = -R^T * t
    const cx = -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2])
    const cy = -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2])
    const cz = -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2])
    const centre = new THREE.Vector3(cx, cy, cz)

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
  }
}

function clearReconstructionData() {
  setReconstructionData(new Map(), [])
}

// ── Camera view presets ──────────────────────────────────────────────────────
// Place the camera along a principal axis (three.js is Y-up) looking at the
// scene centre, at a distance that frames the bounding sphere.
const VIEW_OFFSETS = {
  top:    [0,  1,  0],
  bottom: [0, -1,  0],
  front:  [0,  0,  1],
  back:   [0,  0, -1],
  left:   [-1, 0,  0],
  right:  [1,  0,  0],
}

function setView(dir) {
  if (!camera || !controls) return
  const o = VIEW_OFFSETS[dir] || VIEW_OFFSETS.front
  const d = sceneRadius * 2.5
  // For top/bottom the view direction is parallel to the default up vector, so
  // pick an in-plane up so OrbitControls doesn't gimbal-lock.
  if (dir === 'top')         camera.up.set(0, 0, -1)
  else if (dir === 'bottom') camera.up.set(0, 0,  1)
  else                       camera.up.set(0, 1,  0)
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
  camera.up.set(0, 1, 0)
  controls.target.copy(sceneCenter)
  camera.position.set(
    sceneCenter.x,
    sceneCenter.y + sceneRadius * 0.5,
    sceneCenter.z + sceneRadius * 2.5,
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

onMounted(init)

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  resizeObserver?.disconnect()
  controls?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div ref="container" class="viewer">
    <div class="overlay">three.js viewer</div>
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
</style>
