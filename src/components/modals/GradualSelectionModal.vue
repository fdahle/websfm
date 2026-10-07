<script setup>
import { computed, onMounted, ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import WarnBox from './ui/WarnBox.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import SettingsField from './ui/SettingsField.vue'
import { sparseMetrics } from '../../workers/computeClient.js'
import { packSparseCloud } from '../../core/sfm/resultCodec.js'
import { selectedSparseIndices } from '../../core/sfm/gradualSelection.js'
const props = defineProps({ cloud: { type: Object, required: true } })
const emit = defineEmits(['close', 'run'])
const metric = ref('error'), threshold = ref(3), metrics = ref(null), error = ref('')
const selected = computed(() => metrics.value && Number.isFinite(threshold.value)
  ? selectedSparseIndices(metrics.value, { metric: metric.value, threshold: Math.max(0, threshold.value) }).length : 0)
const max = computed(() => metric.value === 'error' ? 20 : metric.value === 'angle' ? 30 : 20)
const units = computed(() => metric.value === 'error' ? 'px RMS, above' : metric.value === 'track' ? 'views, below' : 'degrees, below')
onMounted(async () => {
  try { metrics.value = await sparseMetrics(packSparseCloud(props.cloud).result) }
  catch (err) { error.value = err.message }
})
function run() {
  emit('run', { mode: 'sparse', sourceIds: [props.cloud.id], settings: { metric: metric.value, threshold: threshold.value, createdAt: props.cloud.createdAt } })
}
</script>
<template>
  <ModalShell title="Sparse gradual selection" @close="emit('close')">
    <WarnBox>This replaces the main sparse model after successful bundle adjustment. Depth maps, computed dense cloud/mesh, DEM, orthophoto, scale and georeference must then be rebuilt or refitted. Cancel or a failed refinement keeps the original model.</WarnBox>
    <SettingsGroup title="Source">
      <p class="source-line"><strong>{{ cloud.name }}</strong> · {{ cloud.points.length.toLocaleString() }} points</p>
    </SettingsGroup>
    <SettingsGroup title="Selection">
      <SettingsField label="Criterion" label-for="gs-metric">
        <select id="gs-metric" v-model="metric" class="field-select">
          <option value="error">Reprojection error</option>
          <option value="track">Track length</option>
          <option value="angle">Maximum triangulation angle</option>
        </select>
      </SettingsField>
      <SettingsField label="Threshold" label-for="gs-threshold" :unit="units">
        <input id="gs-threshold" v-model.number="threshold" type="number" min="0" :max="max" :step="metric === 'track' ? 1 : 0.1" class="field-input" />
      </SettingsField>
      <input v-model.number="threshold" aria-label="Selection threshold" type="range" min="0" :max="max" :step="metric === 'track' ? 1 : 0.1" class="field-input range" />
      <p v-if="error" role="alert" class="field-hint error">{{ error }}</p>
      <p v-else-if="!metrics" class="field-hint">Computing point statistics…</p>
      <p v-else class="selection-line">{{ selected.toLocaleString() }} selected · {{ (cloud.points.length - selected).toLocaleString() }} remaining</p>
    </SettingsGroup>
    <template #footer><button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!metrics || !selected || cloud.points.length - selected < 6 || !(threshold >= 0)" @click="run">Delete selected + refine</button></template>
  </ModalShell>
</template>
<style scoped src="./ui/modal.css"></style>
<style scoped>
.source-line { font-size: 13px; color: var(--text); }
.selection-line { font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
.field-hint.error { color: var(--danger); }
</style>
