<script setup>
import { computed, ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import WarnBox from './ui/WarnBox.vue'

const props = defineProps({
  canAdjustWithGcps: { type: Boolean, default: false },
  canTransform: { type: Boolean, default: false },
  hasMatches: { type: Boolean, default: false },
  gcpCount: { type: Number, default: 0 },
  poseCount: { type: Number, default: 0 },
  projectCrs: { type: String, default: '' },
})

const emit = defineEmits(['close', 'run'])
const mode = ref(props.canAdjustWithGcps && props.hasMatches ? 'adjust' : 'transform')
const canRun = computed(() => mode.value === 'adjust'
  ? props.canAdjustWithGcps && props.hasMatches
  : props.canTransform)
</script>

<template>
  <ModalShell title="Georeference" @close="emit('close')">
    <p class="intro">
      Place the relative reconstruction in <b>{{ projectCrs || 'the project CRS' }}</b>
      using existing ground control or registered camera positions.
    </p>

    <div class="mode-list">
      <label class="mode-card" :class="{ active: mode === 'adjust', disabled: !canAdjustWithGcps || !hasMatches }">
        <input v-model="mode" type="radio" value="adjust" :disabled="!canAdjustWithGcps || !hasMatches" />
        <span>
          <b>Adjust reconstruction with GCPs</b>
          <small>Rebuild the sparse model with GCP-constrained bundle adjustment, then fit it to the project CRS. Recommended after adding control.</small>
        </span>
      </label>
      <label class="mode-card" :class="{ active: mode === 'transform', disabled: !canTransform }">
        <input v-model="mode" type="radio" value="transform" :disabled="!canTransform" />
        <span>
          <b>Transform current reconstruction only</b>
          <small>Fit scale, rotation and translation without changing camera or point geometry.</small>
        </span>
      </label>
    </div>

    <p class="summary">{{ gcpCount }} GCP{{ gcpCount === 1 ? '' : 's' }} · {{ poseCount }} camera position{{ poseCount === 1 ? '' : 's' }}</p>

    <WarnBox v-if="!canRun">
      <template v-if="mode === 'adjust'">
        Adjustment needs feature matches and at least three enabled 3D control points,
        each marked in two registered images.
      </template>
      <template v-else>
        Georeferencing needs at least three eligible GCPs or registered 3D camera positions.
      </template>
    </WarnBox>
    <WarnBox v-else-if="mode === 'adjust'">
      The adjusted sparse model replaces the current one. Depth maps, the computed dense
      model, DEM, orthophoto and mesh will need to be rebuilt.
    </WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canRun" @click="emit('run', { mode })">
        {{ mode === 'adjust' ? 'Continue to adjustment' : 'Georeference' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.intro, .summary { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text); }
.summary { color: var(--text-dim); }
.mode-list { display: grid; gap: 8px; }
.mode-card {
  display: flex;
  gap: 9px;
  padding: 10px;
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  background: var(--bg);
  cursor: pointer;
}
.mode-card.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.mode-card.disabled { opacity: 0.5; cursor: not-allowed; }
.mode-card input { margin-top: 2px; accent-color: var(--accent); }
.mode-card span { display: grid; gap: 3px; }
.mode-card b { font-size: 13px; color: var(--text); }
.mode-card small { font-size: 11px; line-height: 1.4; color: var(--text-dim); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
