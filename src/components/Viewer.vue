<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'

const props = defineProps({
  theme: { type: String, default: 'dark' },
})

const container = ref(null)
let renderer, scene, camera, animationId, resizeObserver, cube, grid

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

  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000)
  camera.position.set(2.5, 2, 3)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  grid = makeGrid(props.theme)
  scene.add(grid)

  cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x0e639c, metalness: 0.2, roughness: 0.5 }),
  )
  cube.position.y = 0.5
  scene.add(cube)

  const dir = new THREE.DirectionalLight(0xffffff, 2)
  dir.position.set(5, 10, 7)
  scene.add(dir)
  scene.add(new THREE.AmbientLight(0xffffff, 0.4))

  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(el)

  animate()
}

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
  cube.rotation.y += 0.01
  cube.rotation.x += 0.005
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
