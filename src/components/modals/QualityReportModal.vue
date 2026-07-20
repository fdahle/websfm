<script setup>
import { ref, computed } from 'vue'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useMatchesStore } from '../../stores/useMatchesStore.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { useQualityReport } from '../../composables/useQualityReport.js'
import { useLog } from '../../composables/useLog.js'
import EvalOverviewSection from './eval/EvalOverviewSection.vue'
import EvalSparseSection from './eval/EvalSparseSection.vue'
import EvalCalibrationSection from './eval/EvalCalibrationSection.vue'
import EvalAccuracySection from './eval/EvalAccuracySection.vue'
import EvalMatchingSection from './eval/EvalMatchingSection.vue'
import EvalDenseSection from './eval/EvalDenseSection.vue'
import EvalCoverageSection from './eval/EvalCoverageSection.vue'

// The Quality Report hub (PLAN-eval-quality-hub WS0): one wide modal, a left section
// nav, an Overview landing page, and the eight former eval modals folded into section
// components. A greyed nav entry (prerequisite data missing) IS the discoverability
// mechanism that replaced the per-button ribbon gating.
const props = defineProps({
  section: { type: String, default: 'overview' },
})
const emit = defineEmits(['close', 'open-image', 'open-match-list', 'open-image-residuals'])

const recon = useReconstructionStore()
const matchesStore = useMatchesStore()
const projects = useProjectsStore()
const { buildExportReport } = useQualityReport()
const { log } = useLog()

const active = ref(props.section || 'overview')

const hasSparse = computed(() => !!recon.mainSparseCloud)
const hasMatches = computed(() => {
  for (const e of matchesStore.matchStore.values()) if (e.status === 'done' && e.inlierCount) return true
  return false
})
const hasDepth = computed(() => recon.depthMapCount > 0)

const SECTIONS = computed(() => [
  { id: 'overview', label: 'Overview', avail: true, prereq: '' },
  { id: 'matching', label: 'Matching', avail: hasMatches.value, prereq: 'Run matching first' },
  { id: 'sparse', label: 'Sparse', avail: hasSparse.value, prereq: 'Reconstruct first' },
  { id: 'calibration', label: 'Calibration', avail: hasSparse.value, prereq: 'Reconstruct first' },
  { id: 'accuracy', label: 'Accuracy', avail: hasSparse.value, prereq: 'Reconstruct + GCPs/poses' },
  { id: 'coverage', label: 'Coverage', avail: hasSparse.value, prereq: 'Reconstruct first' },
  { id: 'dense', label: 'Dense', avail: hasDepth.value, prereq: 'Build depth maps first' },
])

const componentFor = {
  overview: EvalOverviewSection, matching: EvalMatchingSection, sparse: EvalSparseSection,
  calibration: EvalCalibrationSection, accuracy: EvalAccuracySection,
  coverage: EvalCoverageSection, dense: EvalDenseSection,
}
const activeMeta = computed(() => SECTIONS.value.find((s) => s.id === active.value) ?? SECTIONS.value[0])
const activeComponent = computed(() => componentFor[active.value] ?? EvalOverviewSection)

function go(id) { active.value = id }

const exporting = ref(false)
async function onExport() {
  exporting.value = true
  try {
    const html = await buildExportReport(projects.currentProjectName || 'Project')
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(projects.currentProjectName || 'project').replace(/\s+/g, '_')}_quality_report.html`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    log('Exported quality report (HTML)', 'success', 'Evaluate')
  } catch (err) {
    log(`Quality report export failed: ${err?.message ?? err}`, 'error', 'Evaluate')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="qmodal" role="dialog" aria-modal="true" aria-label="Quality Report">
      <div class="qhead">
        <span class="qtitle">Quality Report</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="qbody">
        <nav class="qnav">
          <button
            v-for="s in SECTIONS"
            :key="s.id"
            class="qnav-item"
            :class="{ active: active === s.id, disabled: !s.avail }"
            :title="s.avail ? '' : s.prereq"
            @click="go(s.id)"
          >{{ s.label }}</button>
        </nav>

        <div class="qsection">
          <div v-if="!activeMeta.avail" class="qempty">
            <div class="qempty-icon">◔</div>
            <div class="qempty-text">{{ activeMeta.prereq }}</div>
          </div>
          <component
            v-else
            :is="activeComponent"
            @go="go"
            @open-image="emit('open-image', $event)"
            @open-image-residuals="emit('open-image-residuals', $event)"
            @open-match-list="emit('open-match-list')"
          />
        </div>
      </div>

      <div class="qfoot">
        <button class="btn" :disabled="exporting" @click="onExport">
          {{ exporting ? 'Exporting…' : 'Export report' }}
        </button>
        <button class="btn" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.qmodal {
  background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px;
  width: 920px; max-width: 94vw; height: 640px; max-height: 90vh;
  display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.qhead {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px; border-bottom: 1px solid var(--panel-border); flex-shrink: 0;
}
.qtitle { font-size: 14px; font-weight: 600; color: var(--text); }
.qbody { flex: 1; display: flex; min-height: 0; }
.qnav {
  width: 150px; flex-shrink: 0; border-right: 1px solid var(--panel-border);
  padding: 8px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
}
.qnav-item {
  text-align: left; background: none; border: none; border-radius: 6px;
  color: var(--text-dim); font: inherit; font-size: 13px; padding: 7px 10px; cursor: pointer;
}
.qnav-item:hover:not(.active) { background: var(--hover-bg); color: var(--text); }
.qnav-item.active { background: var(--accent); color: #fff; }
.qnav-item.disabled { color: var(--text-dim); opacity: 0.45; }
.qnav-item.disabled.active { background: var(--panel-border); color: var(--text-dim); }
.qsection {
  flex: 1; min-width: 0; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.qempty { margin: auto; text-align: center; color: var(--text-dim); }
.qempty-icon { font-size: 34px; opacity: 0.5; }
.qempty-text { font-size: 13px; margin-top: 8px; }
.qfoot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border); flex-shrink: 0;
}
</style>
