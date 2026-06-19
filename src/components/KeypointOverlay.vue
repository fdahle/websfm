<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  url: { type: String, required: true },
  keypoints: { type: Array, default: () => [] },
})

const imgEl = ref(null)
const canvas = ref(null)
let resizeObserver = null

function draw() {
  const c = canvas.value
  const img = imgEl.value
  if (!c || !img) return

  const w = img.clientWidth
  const h = img.clientHeight
  if (!w || !h || !img.naturalWidth) return

  const dpr = window.devicePixelRatio || 1
  c.width = Math.round(w * dpr)
  c.height = Math.round(h * dpr)
  c.style.width = `${w}px`
  c.style.height = `${h}px`

  const ctx = c.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // Map original-image scale (kp.scale) to display pixels.
  const displayScale = w / img.naturalWidth
  ctx.strokeStyle = 'rgba(0, 230, 118, 0.85)'
  ctx.lineWidth = 1

  for (const kp of props.keypoints) {
    const x = kp.nx * w
    const y = kp.ny * h
    const r = Math.max(1.5, (kp.scale || 2) * displayScale)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function onImgLoad() {
  draw()
}

watch(() => props.keypoints, () => draw(), { deep: false })
watch(() => props.url, () => nextTick(draw))

onMounted(() => {
  resizeObserver = new ResizeObserver(draw)
  if (imgEl.value) resizeObserver.observe(imgEl.value)
})

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div class="overlay-wrap">
    <img ref="imgEl" :src="url" class="base-img" @load="onImgLoad" />
    <canvas ref="canvas" class="kp-canvas"></canvas>
  </div>
</template>

<style scoped>
.overlay-wrap {
  position: relative;
  display: inline-block;
  line-height: 0;
}

/* No object-fit: the rendered box equals the image box, so the canvas
   (sized to clientWidth/clientHeight) aligns 1:1 with the pixels. */
.base-img {
  max-width: 100%;
  max-height: 240px;
  width: auto;
  height: auto;
  display: block;
  background: #000;
}

.kp-canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
</style>
