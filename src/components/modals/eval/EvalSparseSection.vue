<script setup>
import { computed } from 'vue'
import StatTiles from '../ui/StatTiles.vue'
import DataTable from '../ui/DataTable.vue'
import ImageNameList from './ImageNameList.vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useQualityReport } from '../../../composables/useQualityReport.js'
import { unregisteredReasonKind } from '../../../core/eval/imageStats.js'
import { EVAL_THRESHOLDS, classify, thresholdHintMsg } from '../../../core/eval/health.js'
import { useModalsStore } from '../../../stores/useModalsStore.js'
import { EXTEND_DEFAULTS } from '../../../core/defaults.user.js'
import { useI18n } from '../../../composables/useI18n.js'

// Quality Report ▸ Sparse (WS2.1 + WS2.2): Recon Report and Image Errors merged into
// one section. Tiles are ALWAYS derived from the cloud (one consistent set — the old
// two-personality tile set is gone); the run-summary numbers are a clearly-labelled
// secondary strip shown only when a summary exists. The per-image table adds keypoint
// count + accepted-edge degree so "why is this image bad" is answerable in one place,
// and unregistered images carry their first derivable reason.
const emit = defineEmits(['open-image', 'open-image-residuals'])
const { t, tx, locale } = useI18n()
const recon = useReconstructionStore()
const imagesStore = useImagesStore()
// reproj / histogram / perImage are the model's memoised stats (core/eval/sparseStats.js):
// computed once per model, not on every visit to this section.
const { reproj, graph, histogram, perImage } = useQualityReport()

const cameras = computed(() => recon.sparseCameras)
const points = computed(() => recon.mainSparseCloud?.points ?? [])
const byUuid = computed(() => new Map(imagesStore.images.map((im) => [im.uuid, im])))
const maxBin = computed(() => Math.max(1, ...histogram.value.map((b) => b.count)))

// A value with 1 or 2 decimals in the user's language, or a dash.
const fmt = (v, d = 2) => (v == null ? '—' : t(d === 1 ? 'quality.decimal1' : 'quality.decimal2', { v }))
// An image named in a list, a link when it is still in the project.
const byName = computed(() => new Map(imagesStore.images.map((im) => [im.name, im])))
const imageItem = (name, note = '') => ({ key: name, name, imageId: byName.value.get(name)?.id ?? null, note })
// Sparse Model ▸ Add to the model: which images each extension added (sparseRun.js).
const extensions = computed(() =>
  (recon.summary?.extensions ?? []).map((e, i) => ({
    key: `${e.date}-${i}`,
    when: e.date ? new Date(e.date).toLocaleString(locale.value) : '—',
    how: t(e.existingCameras === 'refined' ? 'quality.sparse.added.refined' : 'quality.sparse.added.fixed'),
    added: e.added ?? [],
    notAdded: e.notAdded ?? [],
    images: [
      ...(e.added ?? []).map((name) => imageItem(name)),
      ...(e.notAdded ?? []).map((name) => imageItem(name, t('quality.sparse.added.notPlaced'))),
    ],
  })),
)
// Photos an extension could not place that the model still lacks.
const stillOut = computed(() => {
  const inModel = new Set(
    [...(recon.mainSparseCloud?.cameras?.keys() ?? [])].map(
      (u) => imagesStore.images.find((im) => im.uuid === u)?.name,
    ),
  )
  const last = extensions.value.at(-1)
  return last ? last.notAdded.filter((name) => !inModel.has(name)) : []
})
// Try again…: Sparse Reconstruction, Add to the model with looser registration gates.
function retryAdd() {
  const m = useModalsStore()
  m.reconstructPrefill = { addToModel: true, ...EXTEND_DEFAULTS.retryGates }
  m.qualityOpen = false
  m.reconstructOpen = true
}

const thr = EVAL_THRESHOLDS.reprojMedianPx
const tiles = computed(() => {
  const d = reproj.value
  return [
    {
      label: t('quality.sparse.tile.registered'),
      value: t('quality.sparse.tile.registeredValue', { n: cameras.value.size, total: imagesStore.images.length }),
      hint: t('quality.sparse.tile.photos'),
    },
    { label: t('quality.sparse.tile.tiePoints'), value: t('quality.sparse.tile.count', { n: points.value.length }) },
    {
      label: t('quality.sparse.tile.reprojMedian'),
      value: fmt(d.median),
      unit: 'px',
      tone: classify(d.median, thr) === 'ok' ? 'ok' : classify(d.median, thr),
      hint: tx(thresholdHintMsg(thr, 'px')),
    },
    { label: t('quality.sparse.tile.reprojP95'), value: fmt(d.p95), unit: 'px' },
    { label: t('quality.sparse.tile.reprojMax'), value: fmt(d.max), unit: 'px' },
    { label: t('quality.sparse.tile.observations'), value: t('quality.sparse.tile.count', { n: d.n ?? 0 }) },
  ]
})

// Secondary, clearly-labelled: the persisted run summary (may be absent on imports).
const summary = computed(() => recon.summary)
const summaryTiles = computed(() => {
  const s = summary.value
  if (!s) return null
  return [
    { label: t('quality.sparse.summary.tracks3'), value: fmt(s.pct3plusViewTracks, 1), unit: '%' },
    { label: t('quality.sparse.summary.p95Before'), value: fmt(s.preBaP95px), unit: 'px' },
    { label: t('quality.sparse.summary.medianAfter'), value: fmt(s.postBaMedianPx), unit: 'px' },
    {
      label: t('quality.sparse.summary.date'),
      value: s.date ? new Date(s.date).toLocaleDateString(locale.value) : '—',
    },
  ]
})

// Per-image residual rows joined with keypoint count + accepted-edge degree.
const rows = computed(() =>
  perImage.value.map((r) => {
    const im = byUuid.value.get(r.uuid)
    return {
      id: r.uuid,
      imageId: im?.id ?? null,
      name: im?.name ?? r.uuid,
      kp: im?.kpCount ?? null,
      deg: graph.value.degrees.get(r.uuid) ?? 0,
      ...r,
    }
  }),
)

const reasonText = (r) => (r ? t(`quality.sparse.reason.${r.kind}`, { n: r.component }) : '')

const unregistered = computed(() => {
  const g = graph.value
  return imagesStore.images
    .filter((im) => !cameras.value.has(im.uuid))
    .map((im) => ({
      key: im.uuid,
      name: im.name,
      imageId: im.id,
      note: reasonText(
        unregisteredReasonKind({
          kpCount: im.kpCount ?? null,
          degree: g.degrees.get(im.uuid) ?? 0,
          componentIndex: g.componentIndex.get(im.uuid) ?? null,
        }),
      ),
    }))
})

const count = (v) => (v == null ? '—' : t('quality.sparse.tile.count', { n: v }))
const columns = computed(() => [
  { key: 'name', label: t('quality.sparse.table.photo') },
  { key: 'kp', label: t('quality.sparse.table.keypoints'), align: 'right', format: count },
  { key: 'deg', label: t('quality.sparse.table.pairs'), align: 'right', format: count },
  { key: 'nObs', label: t('quality.sparse.table.observations'), align: 'right', format: count },
  // DataTable calls format(value, row): fmt's second argument is its digits, so wrap it.
  { key: 'rmsPx', label: t('quality.sparse.table.rms'), align: 'right', format: (v) => fmt(v) },
  { key: 'medianPx', label: t('quality.sparse.table.median'), align: 'right', format: (v) => fmt(v) },
  { key: 'maxPx', label: t('quality.sparse.table.max'), align: 'right', format: (v) => fmt(v) },
])

function onRow(row) {
  if (row.imageId != null) emit('open-image-residuals', row.imageId)
}
</script>

<template>
  <div v-if="!points.length" class="eval-loading">{{ t('quality.sparse.noModel') }}</div>
  <template v-else>
    <StatTiles :tiles="tiles" />

    <div v-if="summaryTiles" class="run-sum">
      <div class="run-sum-title">
        {{ t('quality.sparse.summary.title') }}
        <span class="run-sum-note">{{ t('quality.sparse.summary.note') }}</span>
      </div>
      <StatTiles :tiles="summaryTiles" />
    </div>

    <details v-for="e in extensions" :key="e.key" class="unreg">
      <summary>
        {{
          t('quality.sparse.added.title', {
            when: e.when,
            added: e.added.length,
            notPlaced: e.notAdded.length,
            how: e.how,
          })
        }}
      </summary>
      <ImageNameList :items="e.images" @open-image="emit('open-image', $event)" />
      <p v-if="e === extensions.at(-1) && stillOut.length" class="eval-note">
        <button class="btn" @click="retryAdd">{{ t('quality.sparse.added.retry') }}</button>
        {{
          t('quality.sparse.added.retryNote', {
            n: stillOut.length,
            matches: EXTEND_DEFAULTS.retryGates.minMatchesForRegistration,
            px: EXTEND_DEFAULTS.retryGates.reprjThreshold,
          })
        }}
      </p>
    </details>

    <div class="hist">
      <div class="hist-title">{{ t('quality.sparse.tracks.title') }}</div>
      <div v-for="b in histogram" :key="b.views" class="hist-row">
        <span class="hist-label">{{ b.views }}</span>
        <div class="hist-track"><div class="hist-bar" :style="{ width: (b.count / maxBin) * 100 + '%' }"></div></div>
        <span class="hist-count">{{ count(b.count) }}</span>
        <span class="hist-pct">{{ fmt(b.pct, 1) }}%</span>
      </div>
      <div class="hist-foot">{{ t('quality.sparse.tracks.foot') }}</div>
    </div>

    <DataTable
      :columns="columns"
      :rows="rows"
      sort-key="rmsPx"
      sort-dir="desc"
      :empty-text="t('quality.sparse.table.empty')"
      @row-click="onRow"
    />
    <p class="eval-note">{{ t('quality.sparse.table.note') }}</p>

    <details v-if="unregistered.length" class="unreg">
      <summary>{{ t('quality.sparse.notRegistered', { n: unregistered.length }) }}</summary>
      <ImageNameList :items="unregistered" @open-image="emit('open-image', $event)" />
    </details>
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
}
.run-sum {
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.run-sum-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.run-sum-note {
  font-weight: 400;
  color: var(--text-dim);
}
.hist {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hist-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 2px;
}
.hist-row {
  display: grid;
  grid-template-columns: 28px 1fr 60px 48px;
  align-items: center;
  gap: 8px;
}
.hist-label {
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.hist-track {
  background: var(--bg);
  border-radius: 3px;
  height: 14px;
  overflow: hidden;
}
.hist-bar {
  background: var(--accent);
  height: 100%;
  min-width: 1px;
  border-radius: 3px;
}
.hist-count {
  font-size: 12px;
  color: var(--text);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.hist-pct {
  font-size: 11px;
  color: var(--text-dim);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.hist-foot {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 2px;
}
.unreg {
  font-size: 12px;
}
.unreg summary {
  cursor: pointer;
  color: var(--text-dim);
}
</style>
