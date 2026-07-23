<script setup>
// Consent + progress for the on-demand ONNX model download (useModelsStore).
// Opened automatically the first time a learned backend (SuperPoint / LightGlue /
// SAM2 Smart Select) needs weights that aren't cached yet. The user approves once
// per machine; the weights land in Cache Storage and this never reappears for them.
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useModelsStore } from '../../stores/useModelsStore.js'
import ModalShell from './ui/ModalShell.vue'

const models = useModelsStore()
const { request, downloading, progress, errorMsg, totalLoaded } = storeToRefs(models)

const totalMB = computed(() => models.toMB(request.value?.totalBytes ?? 0))

function pct(item) {
  const p = progress.value[item.id]
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.loaded / p.total) * 100))
}
const overallPct = computed(() => {
  const { loaded, total } = totalLoaded.value
  return total ? Math.min(100, Math.round((loaded / total) * 100)) : 0
})

// While downloading the modal is not dismissable (closing would leave a half-
// written cache entry). Backdrop/Escape close maps to decline only pre-download.
function onClose() { if (!downloading.value) models.decline() }
</script>

<template>
  <ModalShell
    v-if="request"
    title="Download model files"
    aria-label="Download model files"
    @close="onClose"
  >
    <p class="mdl-intro">
      This feature runs a learned neural-network model in your browser. The model
      weights ({{ totalMB }} MB total) are downloaded once and cached locally — no
      images ever leave your machine. Continue?
    </p>

    <ul class="mdl-list">
      <li v-for="item in request.items" :key="item.id" class="mdl-item">
        <div class="mdl-row">
          <span class="mdl-label">{{ item.label }}</span>
          <span class="mdl-size">{{ models.toMB(item.approxBytes) }} MB</span>
        </div>
        <div v-if="item.license" class="mdl-license">License: {{ item.license }}</div>
        <div v-if="downloading" class="mdl-bar">
          <div class="mdl-bar-fill" :style="{ width: pct(item) + '%' }" />
        </div>
      </li>
    </ul>

    <p v-if="downloading" class="mdl-overall">Downloading… {{ overallPct }}%</p>
    <p v-if="errorMsg" class="mdl-error">{{ errorMsg }}</p>

    <template #footer>
      <button v-if="!downloading" class="btn" @click="models.decline()">Cancel</button>
      <button v-if="!downloading" class="btn btn-primary" @click="models.approve()">
        Download ({{ totalMB }} MB)
      </button>
      <button v-else class="btn" disabled>Downloading…</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.mdl-intro { margin: 0 0 14px; line-height: 1.5; }
.mdl-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.mdl-item { display: flex; flex-direction: column; gap: 6px; }
.mdl-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.mdl-label { font-size: 13px; }
.mdl-size { font-size: 12px; opacity: 0.7; font-variant-numeric: tabular-nums; }
.mdl-license { font-size: 11px; opacity: 0.6; }
.mdl-bar { height: 6px; border-radius: 3px; background: var(--panel-border); overflow: hidden; }
.mdl-bar-fill { height: 100%; background: var(--accent); transition: width 0.15s linear; }
.mdl-overall { margin: 14px 0 0; font-size: 13px; opacity: 0.8; font-variant-numeric: tabular-nums; }
.mdl-error { margin: 12px 0 0; color: var(--danger, #e05252); font-size: 13px; }
</style>
