<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'
import { useQualityReport } from '../../../composables/useQualityReport.js'
import { t } from '../../../composables/useI18n.js'
import SegmentedControl from '../ui/SegmentedControl.vue'
// Quality Report ▸ Coverage: a top-down map of the model. On an aerial project it opens
// on the photo overlap (core/eval/coverage.js overlapGrid: how many photos see each patch
// of ground), the map that shows where the dense cloud will be thin; the tie-point map
// (coverageGrid: cells coloured by their longest track) is the other view, and the only
// one for an object capture, where "ground" has no meaning. The model is oriented Z-up
// for aerial projects at reconstruct time, so point (x, y) is the top-down plane.
const recon = useReconstructionStore()
const { currentSceneType } = storeToRefs(useProjectsStore())
const canvas = ref(null)
const wrap = ref(null)
const points = computed(() => recon.mainSparseCloud?.points ?? [])
// The model's memoised grids (core/eval/sparseStats.js), shared with the rest of the hub.
const { coverage: tieGrid, overlap } = useQualityReport()
const aerial = computed(() => currentSceneType.value !== 'object')
const mode = ref(aerial.value ? 'photos' : 'ties')
const modes = computed(() => [
  { id: 'photos', label: t('quality.coverage.modePhotos') },
  { id: 'ties', label: t('quality.coverage.modeTiePoints') },
])
const showPhotos = computed(() => aerial.value && mode.value === 'photos')

// Photos per cell → colour: 1 red (nothing to confirm a depth), 2 amber (one other
// photo), 3 and more greens deepening to 5+.
const PHOTO_COLOURS = ['#8a3524', '#c78a1e', '#7fb86a', '#3f9e5e', '#1f6e45']
const photoColour = (n) => (n > 0 ? PHOTO_COLOURS[Math.min(n, 5) - 1] : null)
// Longest track in a tie-point cell → colour: 1 red, 2 amber, ≥3 green deepening.
function tieColour(views, count) {
  if (!count) return null
  if (views <= 1) return '#8a3524'
  if (views === 2) return '#c78a1e'
  const k = Math.min(1, (views - 3) / 5)
  return `rgb(46, ${Math.round(140 + k * 70)}, 91)`
}
const legend = computed(() =>
  showPhotos.value
    ? PHOTO_COLOURS.map((c, i) => ({
        colour: c,
        label: i < 4 ? t('quality.coverage.photos', { n: i + 1 }) : t('quality.coverage.photosPlus', { n: 5 }),
      }))
    : [
        { colour: '#8a3524', label: t('quality.coverage.views', { n: 1 }) },
        { colour: '#c78a1e', label: t('quality.coverage.viewsMinimum') },
        { colour: '#2e8c5b', label: t('quality.coverage.viewsGood') },
      ],
)
const shares = computed(() => {
  const s = showPhotos.value ? overlap.value?.shares : null
  return s && overlap.value.cols ? { one: s.one, two: s.two, more: s.threePlus } : null
})

function draw() {
  const cv = canvas.value
  if (!cv) return
  const g = showPhotos.value ? overlap.value : tieGrid.value
  const colourAt = showPhotos.value
    ? (idx) => photoColour(g.views[idx])
    : (idx) => tieColour(g.maxViews[idx], g.count[idx])
  const W = wrap.value?.clientWidth || 600
  const aspect = g.rows && g.cols ? g.rows / g.cols : 0.6
  const H = Math.max(180, Math.min(460, Math.round(W * aspect)))
  const dpr = window.devicePixelRatio || 1
  cv.width = W * dpr
  cv.height = H * dpr
  cv.style.width = W + 'px'
  cv.style.height = H + 'px'
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  if (!g.cols || !g.rows) return
  // Fit the grid into the canvas with a margin, flipping Y so north is up.
  const pad = 14
  const s = Math.min((W - 2 * pad) / g.cols, (H - 2 * pad) / g.rows)
  const offX = pad + (W - 2 * pad - s * g.cols) / 2
  const offY = pad + (H - 2 * pad - s * g.rows) / 2
  const toX = (col) => offX + col * s
  const toY = (row) => offY + (g.rows - 1 - row) * s
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const col = colourAt(r * g.cols + c)
      if (!col) continue
      ctx.fillStyle = col
      ctx.fillRect(toX(c), toY(r), Math.ceil(s), Math.ceil(s))
    }
  }
  // Camera centres → grid space → canvas.
  ctx.fillStyle = '#4fc3f7'
  const cs = g.cellSize || 1
  for (const cam of g.cams) {
    ctx.beginPath()
    ctx.arc(toX((cam.x - g.minX) / cs), toY((cam.y - g.minY) / cs), 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
}
onMounted(() => nextTick(draw))
watch([tieGrid, overlap, showPhotos], () => nextTick(draw))
</script>

<template>
  <div v-if="!points.length" class="eval-loading">{{ t('quality.coverage.noSparse') }}</div>
  <template v-else>
    <div v-if="aerial" class="cov-mode" :title="t('quality.coverage.modeTip')">
      <SegmentedControl v-model="mode" :options="modes" />
    </div>
    <div ref="wrap" class="cov-wrap">
      <canvas ref="canvas" class="cov-canvas"></canvas>
    </div>
    <div class="legend">
      <span v-for="l in legend" :key="l.label" class="lg"><i :style="{ background: l.colour }"></i>{{ l.label }}</span>
      <span class="lg"><i class="dot"></i>{{ t('quality.coverage.camera') }}</span>
    </div>
    <p v-if="shares" class="eval-note">{{ t('quality.coverage.twoPhotoShare', shares) }}</p>
    <p class="eval-note">{{ showPhotos ? t('quality.coverage.notePhotos') : t('quality.coverage.noteTiePoints') }}</p>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading {
  padding: 24px;
  text-align: center;
  color: var(--text-dim);
}
.eval-note {
  font-size: 11px;
  color: var(--text-dim);
  margin: 2px 0 0;
  line-height: 1.5;
}
.cov-mode {
  margin-bottom: 6px;
}
.cov-wrap {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 4px;
}
.cov-canvas {
  display: block;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 11px;
  color: var(--text-dim);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.lg i {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  display: inline-block;
}
.lg i.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4fc3f7;
}
</style>
