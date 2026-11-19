<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import DataTable from '../ui/DataTable.vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'
import { linearCrsUnit } from '../../../core/crs.js'
import { compareAccuracy } from '../../../core/eval/accuracySnapshot.js'
import { t } from '../../../composables/useI18n.js'

// Evaluate ▸ Accuracy: how accurate the georeferenced model is after the last fit,
// against the fit before it (core/eval/accuracySnapshot.js, recorded after every
// georeference), and every fit kept. Only independent checks are compared: checkpoints,
// leave-one-out of four or more control points, and the camera positions when the fit
// was made to the GCPs; one measured on other points than before is not compared.
const recon = useReconstructionStore()
const { accuracyHistory } = storeToRefs(recon)
const { currentCrs } = storeToRefs(useProjectsStore())
const unit = computed(() => linearCrsUnit(currentCrs.value) || '')

const cur = computed(() => accuracyHistory.value.at(-1) ?? null)
const prev = computed(() => accuracyHistory.value.at(-2) ?? null)
const diff = computed(() => (cur.value ? compareAccuracy(cur.value, prev.value) : null))

const methodText = (m) => t(`accuracy.method.${['gcps', 'poses', 'dem-hold'].includes(m) ? m : 'other'}`)
const whenText = (at) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}
const val = (v) => (v == null ? '—' : t('accuracy.value', { v, unit: unit.value }))

// The metric rows of the comparison, each with its label and verdict.
const rows = computed(() =>
  (diff.value?.rows ?? []).map((r) => {
    const n = (cur.value?.[r.key] ?? prev.value?.[r.key])?.n ?? 0
    return {
      ...r,
      id: `${r.key}-${r.axis}`,
      label: `${t(`accuracy.metric.${r.key}`, { n })}, ${t(`accuracy.axis.${r.axis}`)}`,
    }
  }),
)
// What changed between the two fits besides the numbers.
const notes = computed(() => {
  const d = diff.value
  if (!d || !prev.value) return []
  const out = []
  if (cur.value.change) out.push(t('accuracy.change', { change: cur.value.change }))
  for (const k of ['controlsAdded', 'controlsRemoved', 'checksAdded', 'checksRemoved'])
    if (d[k].length) out.push(t(`accuracy.${k}`, { names: d[k].join(', ') }))
  return out
})

const pair = (s) => (s ? t('accuracy.pair', { h: s.h, v: s.v }) : '—')
const columns = computed(() => [
  { key: 'when', label: t('accuracy.col.when'), sortable: false },
  { key: 'method', label: t('accuracy.col.method'), sortable: false },
  { key: 'change', label: t('accuracy.col.change'), sortable: false },
  { key: 'points', label: t('accuracy.col.points'), align: 'right', sortable: false },
  { key: 'checkpoints', label: t('accuracy.col.checkpoints'), align: 'right', sortable: false },
  { key: 'loo', label: t('accuracy.col.loo'), align: 'right', sortable: false },
  { key: 'cameras', label: t('accuracy.col.cameras'), align: 'right', sortable: false },
])
// Newest first.
const historyRows = computed(() =>
  [...accuracyHistory.value].reverse().map((s, i) => ({
    id: `${s.at}-${i}`,
    when: whenText(s.at),
    method: methodText(s.method),
    change: s.change ?? '',
    points: `${s.controls.length} / ${s.checks.length}`,
    checkpoints: pair(s.checkpoints),
    loo: pair(s.loo),
    cameras: pair(s.cameras),
  })),
)
</script>

<template>
  <section class="acc-history">
    <h4 class="ah-title">{{ t('accuracy.title') }}</h4>
    <p v-if="!cur" class="ah-note">{{ t('accuracy.empty') }}</p>
    <template v-else>
      <p class="ah-meta">{{ t('accuracy.fitted', { when: whenText(cur.at), method: methodText(cur.method) }) }}</p>
      <p v-for="(n, i) in notes" :key="i" class="ah-meta">{{ n }}</p>
      <p v-if="!cur.independent" class="ah-warn">{{ t('accuracy.noIndependent') }}</p>
      <p v-else-if="!prev" class="ah-note">{{ t('accuracy.first') }}</p>
      <table v-if="cur.independent && rows.length" class="ah-table">
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="`v-${r.verdict}`">
            <td class="ah-label">{{ r.label }}</td>
            <td class="ah-num">{{ val(r.prev) }}</td>
            <td class="ah-arrow">→</td>
            <td class="ah-num">{{ val(r.cur) }}</td>
            <td class="ah-verdict">{{ t(`accuracy.verdict.${r.verdict}`) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="ah-note">{{ t('accuracy.why') }}</p>
      <details v-if="accuracyHistory.length > 1" class="ah-details">
        <summary>{{ t('accuracy.history') }} ({{ accuracyHistory.length }})</summary>
        <DataTable :columns="columns" :rows="historyRows" />
      </details>
    </template>
  </section>
</template>

<style scoped>
.acc-history {
  margin: 4px 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: var(--panel);
}
.ah-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}
.ah-meta,
.ah-note,
.ah-warn {
  margin: 2px 0;
  font-size: 12px;
  color: var(--text-dim);
}
.ah-warn {
  color: #e0a030;
}
.ah-table {
  margin: 6px 0;
  border-collapse: collapse;
  font-size: 12px;
}
.ah-table td {
  padding: 2px 10px 2px 0;
}
.ah-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ah-arrow {
  color: var(--text-dim);
}
.v-better .ah-verdict {
  color: var(--success, #3fbf6f);
}
.v-worse .ah-verdict {
  color: #e05555;
}
.v-same .ah-verdict,
.v-changed .ah-verdict,
.v-new .ah-verdict,
.v-gone .ah-verdict {
  color: var(--text-dim);
}
.ah-details {
  margin-top: 6px;
  font-size: 12px;
  overflow-x: auto;
}
.ah-details summary {
  cursor: pointer;
  color: var(--text-dim);
}
</style>
