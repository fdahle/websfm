<script setup>
import { ref, watch, computed } from 'vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useQualityReport } from '../../../composables/useQualityReport.js'
import { diffSummaries } from '../../../core/eval/compareRuns.js'

// Quality Report ▸ Overview (WS1). One status list answering "is my project healthy,
// where is it bad" — dot + label + value + hint per metric; click jumps to the owning
// section. The GCP report is async, so rows load lazily and recompute when
// recon.healthDirty moves (a GCP prune / refit). A compact "vs previous run" strip
// (WS5) sits on top when a run history exists.
const emit = defineEmits(['go'])
const recon = useReconstructionStore()
const { computeHealth } = useQualityReport()

const rows = ref([])
const loading = ref(true)

async function refresh() {
  loading.value = true
  const { rows: r } = await computeHealth()
  rows.value = r
  loading.value = false
}
watch(() => recon.healthDirty, refresh, { immediate: true })

const counts = computed(() => {
  const c = { ok: 0, warn: 0, bad: 0, missing: 0 }
  for (const r of rows.value) c[r.status] = (c[r.status] ?? 0) + 1
  return c
})

const fmtVal = (r) => (r.value == null ? '—'
  : (typeof r.value === 'number' ? (Number.isInteger(r.value) ? r.value : r.value.toFixed(2)) : r.value))

// Run comparison (WS5): current summary vs the most recent in history.
const runDiff = computed(() => {
  const hist = recon.summaryHistory
  if (!recon.summary || !hist?.length) return null
  return diffSummaries(recon.summary, hist[hist.length - 1])
})
const arrow = (v) => (v === 'better' ? '▲' : v === 'worse' ? '▼' : '·')
function fmtDelta(d) {
  if (d.delta == null) return ''
  const s = d.delta > 0 ? '+' : ''
  return `${s}${Math.abs(d.delta) >= 100 ? Math.round(d.delta) : d.delta.toFixed(d.digits)}`
}
</script>

<template>
  <div v-if="loading" class="eval-loading">Computing project health…</div>
  <template v-else>
    <div class="ov-summary">
      <span class="chip chip-ok">{{ counts.ok }} OK</span>
      <span class="chip chip-warn">{{ counts.warn }} warn</span>
      <span class="chip chip-bad">{{ counts.bad }} bad</span>
      <span class="chip chip-missing">{{ counts.missing }} n/a</span>
    </div>

    <div class="health-list">
      <button
        v-for="r in rows"
        :key="r.id"
        class="hrow"
        :class="`st-${r.status}`"
        @click="emit('go', r.section)"
      >
        <span class="dot"></span>
        <span class="hlabel">{{ r.label }}</span>
        <span class="hval">{{ fmtVal(r) }}<span v-if="r.unit && r.value != null" class="hunit"> {{ r.unit }}</span></span>
        <span class="hhint">{{ r.hint }}</span>
        <span class="harrow">›</span>
      </button>
    </div>

    <div v-if="runDiff" class="run-strip">
      <div class="run-title">vs previous run</div>
      <div class="run-metrics">
        <div v-for="d in runDiff" :key="d.key" class="run-metric" :class="`v-${d.verdict}`">
          <span class="rm-arrow">{{ arrow(d.verdict) }}</span>
          <span class="rm-label">{{ d.label }}</span>
          <span class="rm-delta">{{ fmtDelta(d) }}{{ d.unit }}</span>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading { padding: 24px; text-align: center; color: var(--text-dim); }
.ov-summary { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font-size: 11px; border-radius: 999px; padding: 2px 9px; border: 1px solid var(--panel-border); color: var(--text-dim); }
.chip-ok { color: var(--accent); }
.chip-warn { color: #e6a01e; }
.chip-bad { color: #e0533d; }

.health-list { display: flex; flex-direction: column; gap: 2px; }
.hrow {
  display: grid; grid-template-columns: 14px 180px 90px 1fr 14px; align-items: center; gap: 10px;
  background: none; border: none; border-radius: 6px; padding: 8px 10px; cursor: pointer;
  font: inherit; text-align: left; color: var(--text);
}
.hrow:hover { background: var(--hover-bg); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #888; }
.st-ok .dot { background: var(--accent); }
.st-warn .dot { background: #e6a01e; }
.st-bad .dot { background: #e0533d; }
.st-missing { opacity: 0.55; }
.hlabel { font-size: 13px; }
.hval { font-size: 13px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.hunit { font-size: 11px; font-weight: 400; color: var(--text-dim); }
.hhint { font-size: 11px; color: var(--text-dim); }
.harrow { color: var(--text-dim); text-align: center; }

.run-strip { border: 1px solid var(--panel-border); border-radius: 8px; padding: 10px 12px; }
.run-title { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.run-metrics { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.run-metric { display: inline-flex; align-items: baseline; gap: 6px; font-size: 12px; }
.rm-arrow { font-size: 11px; }
.v-better .rm-arrow, .v-better .rm-delta { color: var(--accent); }
.v-worse .rm-arrow, .v-worse .rm-delta { color: #e0533d; }
.v-same .rm-arrow { color: var(--text-dim); }
.rm-label { color: var(--text-dim); }
.rm-delta { font-variant-numeric: tabular-nums; }
</style>
