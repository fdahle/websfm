<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { coverageGrid } from '../../../core/eval/coverage.js'
import { cameraCenter } from '../../../core/sfm/geometry.js'

// Quality Report ▸ Coverage (WS4): a top-down 2D density map of the sparse frame —
// "where is my survey thin". Cells coloured by MAX view count (the photogrammetric
// quantity: 2 = bare minimum, ≥3 comfortable), camera centres overlaid. The model is
// already oriented Z-up for aerial projects at reconstruct time, so point (x,y) IS the
// top-down plane; no extra re-projection here.
const recon = useReconstructionStore()

const canvas = ref(null)
const wrap = ref(null)

const points = computed(() => recon.mainSparseCloud?.points ?? [])
const cams = computed(() => {
  const out = []
  for (const cam of recon.sparseCameras.values()) {
    const c = cameraCenter(cam)
    if (c) out.push({ x: c[0], y: c[1] })
  }
  return out
})
const grid = computed(() => coverageGrid(points.value.map((p) => ({ x: p.x, y: p.y, views: p.views })), cams.value, { targetCells: 64 }))

// View-count → colour: 0 empty, 1 red (single view, unusable), 2 amber (minimum),
// ≥3 green (comfortable, deepening with count).
function cellColor(views, count) {
  if (!count) return null
  if (views <= 1) return '#8a3524'
  if (views === 2) return '#c78a1e'
  const t = Math.min(1, (views - 3) / 5)
  const g = Math.round(140 + t * 70)
  return `rgb(46, ${g}, 91)`
}

function draw() {
  const cv = canvas.value
  const g = grid.value
  if (!cv) return
  const W = wrap.value?.clientWidth || 600
  const aspect = g.rows && g.cols ? g.rows / g.cols : 0.6
  const H = Math.max(180, Math.min(460, Math.round(W * aspect)))
  const dpr = window.devicePixelRatio || 1
  cv.width = W * dpr; cv.height = H * dpr
  cv.style.width = W + 'px'; cv.style.height = H + 'px'
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  if (!g.cols || !g.rows) return

  // Fit the grid into the canvas with a margin, flipping Y so north is up.
  const pad = 14
  const sx = (W - 2 * pad) / g.cols
  const sy = (H - 2 * pad) / g.rows
  const s = Math.min(sx, sy)
  const offX = pad + (W - 2 * pad - s * g.cols) / 2
  const offY = pad + (H - 2 * pad - s * g.rows) / 2
  const toX = (col) => offX + col * s
  const toY = (row) => offY + (g.rows - 1 - row) * s

  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const idx = r * g.cols + c
      const col = cellColor(g.maxViews[idx], g.count[idx])
      if (!col) continue
      ctx.fillStyle = col
      ctx.fillRect(toX(c), toY(r), Math.ceil(s), Math.ceil(s))
    }
  }

  // Camera centres → grid space → canvas.
  ctx.fillStyle = '#4fc3f7'
  const cs = g.cellSize || 1
  for (const cam of g.cams) {
    const col = (cam.x - g.minX) / cs
    const row = (cam.y - g.minY) / cs
    ctx.beginPath()
    ctx.arc(toX(col), toY(row), 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
}

onMounted(() => nextTick(draw))
watch(grid, () => nextTick(draw))
</script>

<template>
  <div v-if="!points.length" class="eval-loading">No sparse cloud.</div>
  <template v-else>
    <div ref="wrap" class="cov-wrap">
      <canvas ref="canvas" class="cov-canvas"></canvas>
    </div>
    <div class="legend">
      <span class="lg"><i style="background:#8a3524"></i>1 view</span>
      <span class="lg"><i style="background:#c78a1e"></i>2 (minimum)</span>
      <span class="lg"><i style="background:#2e8c5b"></i>3+ (good)</span>
      <span class="lg"><i class="dot"></i>camera</span>
    </div>
    <p class="eval-note">
      Top-down tie-point density, cells coloured by how many images see that patch of ground.
      Thin (red/amber) regions are where the survey is weakest.
    </p>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading { padding: 24px; text-align: center; color: var(--text-dim); }
.eval-note { font-size: 11px; color: var(--text-dim); margin: 2px 0 0; line-height: 1.5; }
.cov-wrap { width: 100%; background: var(--bg); border: 1px solid var(--panel-border); border-radius: 8px; padding: 4px; }
.cov-canvas { display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 11px; color: var(--text-dim); }
.lg { display: inline-flex; align-items: center; gap: 5px; }
.lg i { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.lg i.dot { width: 8px; height: 8px; border-radius: 50%; background: #4fc3f7; }
</style>
