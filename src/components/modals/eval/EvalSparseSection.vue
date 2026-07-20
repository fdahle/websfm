<script setup>
import { computed } from 'vue'
import StatTiles from '../ui/StatTiles.vue'
import DataTable from '../ui/DataTable.vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useQualityReport } from '../../../composables/useQualityReport.js'
import { perImageResiduals, unregisteredReason } from '../../../core/eval/imageStats.js'
import { trackLengthHistogram } from '../../../core/eval/reconStats.js'
import { EVAL_THRESHOLDS, classify, thresholdHint } from '../../../core/eval/health.js'

// Quality Report ▸ Sparse (WS2.1 + WS2.2): Recon Report and Image Errors merged into
// one section. Tiles are ALWAYS derived from the cloud (one consistent set — the old
// two-personality tile set is gone); the run-summary numbers are a clearly-labelled
// secondary strip shown only when a summary exists. The per-image table adds keypoint
// count + accepted-edge degree so "why is this image bad" is answerable in one place,
// and unregistered images carry their first derivable reason.
const emit = defineEmits(['open-image', 'open-image-residuals'])
const recon = useReconstructionStore()
const imagesStore = useImagesStore()
const { reproj, graph } = useQualityReport()

const cameras = computed(() => recon.sparseCameras)
const points = computed(() => recon.mainSparseCloud?.points ?? [])
const byUuid = computed(() => new Map(imagesStore.images.map((im) => [im.uuid, im])))
const histogram = computed(() => trackLengthHistogram(points.value))
const maxBin = computed(() => Math.max(1, ...histogram.value.map((b) => b.count)))

const fmt = (v, d = 2) => (v == null ? '—' : v.toFixed(d))

const thr = EVAL_THRESHOLDS.reprojMedianPx
const tiles = computed(() => {
  const d = reproj.value
  return [
    { label: 'Registered', value: `${cameras.value.size} / ${imagesStore.images.length}`, hint: 'images' },
    { label: 'Points', value: points.value.length.toLocaleString() },
    { label: 'Reproj median', value: fmt(d.median), unit: 'px',
      tone: classify(d.median, thr) === 'ok' ? 'ok' : classify(d.median, thr),
      hint: thresholdHint(thr, 'px') },
    { label: 'Reproj P95', value: fmt(d.p95), unit: 'px' },
    { label: 'Reproj max', value: fmt(d.max), unit: 'px' },
    { label: 'Observations', value: (d.n ?? 0).toLocaleString() },
  ]
})

// Secondary, clearly-labelled: the persisted run summary (may be absent on imports).
const summary = computed(() => recon.summary)
const summaryTiles = computed(() => {
  const s = summary.value
  if (!s) return null
  return [
    { label: '≥3-view tracks', value: fmt(s.pct3plusViewTracks, 1), unit: '%' },
    { label: 'Pre-BA P95', value: fmt(s.preBaP95px), unit: 'px' },
    { label: 'Post-BA median', value: fmt(s.postBaMedianPx), unit: 'px' },
    { label: 'Run date', value: s.date ? new Date(s.date).toLocaleDateString() : '—' },
  ]
})

// Per-image residual rows joined with keypoint count + accepted-edge degree.
const rows = computed(() =>
  perImageResiduals(cameras.value, points.value).map((r) => {
    const im = byUuid.value.get(r.uuid)
    return {
      id: r.uuid, imageId: im?.id ?? null, name: im?.name ?? r.uuid,
      kp: im?.kpCount ?? null, deg: graph.value.degrees.get(r.uuid) ?? 0, ...r,
    }
  }),
)

const unregistered = computed(() => {
  const g = graph.value
  return imagesStore.images
    .filter((im) => !cameras.value.has(im.uuid))
    .map((im) => ({
      uuid: im.uuid, name: im.name,
      reason: unregisteredReason({
        kpCount: im.kpCount ?? null,
        degree: g.degrees.get(im.uuid) ?? 0,
        componentIndex: g.componentIndex.get(im.uuid) ?? null,
      }),
    }))
})

const columns = [
  { key: 'name', label: 'Image' },
  { key: 'kp', label: 'Keypts', align: 'right' },
  { key: 'deg', label: 'Edges', align: 'right' },
  { key: 'nObs', label: 'Obs', align: 'right' },
  { key: 'rmsPx', label: 'RMS', align: 'right', format: fmt },
  { key: 'medianPx', label: 'Median', align: 'right', format: fmt },
  { key: 'maxPx', label: 'Max', align: 'right', format: fmt },
]

function onRow(row) {
  if (row.imageId != null) emit('open-image-residuals', row.imageId)
}
</script>

<template>
  <div v-if="!points.length" class="eval-loading">No sparse cloud.</div>
  <template v-else>
    <StatTiles :tiles="tiles" />

    <div v-if="summaryTiles" class="run-sum">
      <div class="run-sum-title">Run summary <span class="run-sum-note">(from the last reconstruction)</span></div>
      <StatTiles :tiles="summaryTiles" />
    </div>

    <div class="hist">
      <div class="hist-title">Track-length distribution</div>
      <div v-for="b in histogram" :key="b.views" class="hist-row">
        <span class="hist-label">{{ b.views }}</span>
        <div class="hist-track"><div class="hist-bar" :style="{ width: (b.count / maxBin * 100) + '%' }"></div></div>
        <span class="hist-count">{{ b.count.toLocaleString() }}</span>
        <span class="hist-pct">{{ b.pct.toFixed(1) }}%</span>
      </div>
      <div class="hist-foot">views per point (tie points, ≥2 views)</div>
    </div>

    <DataTable :columns="columns" :rows="rows" sort-key="rmsPx" sort-dir="desc"
      empty-text="No registered images." @row-click="onRow" />
    <p class="eval-note">Click a row to open that image with the residual overlay. Sorted worst-first by RMS.</p>

    <details v-if="unregistered.length" class="unreg">
      <summary>Not registered ({{ unregistered.length }})</summary>
      <div class="unreg-list">
        <span v-for="im in unregistered" :key="im.uuid" class="unreg-item">
          {{ im.name }}<span v-if="im.reason" class="unreg-reason"> — {{ im.reason }}</span>
        </span>
      </div>
    </details>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading { padding: 24px; text-align: center; color: var(--text-dim); }
.eval-note { font-size: 11px; color: var(--text-dim); margin: 2px 0 0; }
.run-sum { border: 1px solid var(--panel-border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.run-sum-title { font-size: 12px; font-weight: 600; color: var(--text); }
.run-sum-note { font-weight: 400; color: var(--text-dim); }
.hist { display: flex; flex-direction: column; gap: 4px; }
.hist-title { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 2px; }
.hist-row { display: grid; grid-template-columns: 28px 1fr 60px 48px; align-items: center; gap: 8px; }
.hist-label { font-size: 12px; color: var(--text-dim); text-align: right; font-variant-numeric: tabular-nums; }
.hist-track { background: var(--bg); border-radius: 3px; height: 14px; overflow: hidden; }
.hist-bar { background: var(--accent); height: 100%; min-width: 1px; border-radius: 3px; }
.hist-count { font-size: 12px; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
.hist-pct { font-size: 11px; color: var(--text-dim); text-align: right; font-variant-numeric: tabular-nums; }
.hist-foot { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
.unreg { font-size: 12px; }
.unreg summary { cursor: pointer; color: var(--text-dim); }
.unreg-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.unreg-item { background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px; padding: 2px 8px; color: var(--text); }
.unreg-reason { color: var(--text-dim); }
</style>
