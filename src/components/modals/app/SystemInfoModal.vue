<script setup>
import { formatBytes } from '../../../core/formatBytes.js'
// Hardware / capability / storage diagnostics. Split out of the About modal
// (which is now identity + acknowledgments + licenses) because this is a
// different job: what you point a user at when debugging "what GPU / is SIMD on
// / how much OPFS is left". Copy for bug report puts the same facts on the
// clipboard as a few lines of text (core/systemSummary.js), for the user to paste
// into an issue themselves.
import { ref, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import * as opfs from '../../../utils/opfs.js'
import ModalShell from '../ui/ModalShell.vue'
import { collectSystemInfo } from '../../../utils/systemInfo.js'
import { systemSummaryText } from '../../../core/systemSummary.js'
import { copyToClipboard } from '../../../composables/useToasts.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'

const emit = defineEmits(['close'])
const { currentProject } = storeToRefs(useProjectsStore())

const gpu = ref('Detecting…')
const cores = ref(navigator.hardwareConcurrency || 'Unknown')
const memory = ref(navigator.deviceMemory ? `${navigator.deviceMemory} GB` : 'Unknown')
const browserLine = ref('Detecting…')
const webgl2 = ref(false)
const webgpu = ref(false)
const wasmSimd = ref(false)
// What WebSfM needs from the browser, and what a missing piece costs (core/browserSupport.js).
const support = ref([])

const opfsAvailable = ref(false)
const opfsDurable = ref(false)
const opfsUsed = ref(null)
const opfsQuota = ref(null)
const info = ref(null)

onMounted(async () => {
  const i = await collectSystemInfo({ project: currentProject.value })
  info.value = i
  gpu.value = i.gpu || 'Unknown'
  browserLine.value = `${i.browser} on ${i.os}`
  webgl2.value = !!i.webgl2
  webgpu.value = !!i.webgpu
  wasmSimd.value = !!i.simd
  support.value = i.support
  opfsAvailable.value = await opfs.isAvailable()
  opfsDurable.value = !!i.storage.durable
  opfsUsed.value = i.storage.used ?? null
  opfsQuota.value = i.storage.quota ?? null
})

const copySummary = () => info.value && copyToClipboard(systemSummaryText(info.value), 'system summary')
</script>

<template>
  <ModalShell title="System info" aria-label="System info" @close="emit('close')">
    <div class="section-label">System</div>
    <div class="info-grid">
      <span class="info-key">Browser</span>
      <span class="info-val">{{ browserLine }}</span>

      <span class="info-key">GPU</span>
      <span class="info-val gpu-val">{{ gpu }}</span>

      <span class="info-key">CPU Cores</span>
      <span class="info-val">{{ cores }}</span>

      <span class="info-key">Device Memory</span>
      <span class="info-val">{{ memory }}</span>

      <span class="info-key">WebGL 2</span>
      <span class="info-val" :class="webgl2 ? 'ok' : 'warn'">{{ webgl2 ? 'Supported' : 'Not supported' }}</span>

      <span class="info-key">WebGPU</span>
      <span class="info-val" :class="webgpu ? 'ok' : 'warn'">{{ webgpu ? 'Available' : 'Not available' }}</span>

      <span class="info-key">WASM SIMD</span>
      <span class="info-val" :class="wasmSimd ? 'ok' : 'warn'">{{ wasmSimd ? 'Supported' : 'Not supported' }}</span>
    </div>

    <div class="section-divider" />

    <div class="section-label">Storage</div>
    <div class="info-grid">
      <span class="info-key">OPFS</span>
      <span class="info-val" :class="opfsAvailable ? 'ok' : 'warn'">
        {{ opfsAvailable ? 'Available' : 'Not available' }}
      </span>

      <template v-if="opfsAvailable">
        <span class="info-key">Durable</span>
        <span class="info-val" :class="opfsDurable ? 'ok' : 'warn'">
          {{ opfsDurable ? 'Granted' : 'Not granted' }}
        </span>

        <span class="info-key">Used</span>
        <span class="info-val">{{ formatBytes(opfsUsed) }}</span>

        <span class="info-key">Quota</span>
        <span class="info-val">{{ formatBytes(opfsQuota) }}</span>
      </template>
    </div>

    <div class="section-divider" />

    <div class="section-label">Browser support</div>
    <div class="support-list">
      <div v-for="f in support" :key="f.id" class="support-row">
        <span class="info-key">{{ f.label }}</span>
        <span class="info-val" :class="f.ok ? 'ok' : 'warn'">{{ f.ok ? 'Yes' : 'No' }}</span>
        <span v-if="!f.ok" class="support-without">{{ f.without }}</span>
      </div>
    </div>

    <template #footer>
      <button
        class="btn"
        :disabled="!info"
        :title="
          info
            ? 'Copy browser, OS, GPU, memory and storage as text, to paste into a bug report. Nothing about your project is included.'
            : 'Wait for the checks to finish'
        "
        @click="copySummary"
      >
        Copy for bug report
      </button>
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.section-divider {
  border: none;
  border-top: 1px solid var(--panel-border);
  margin: 14px 0;
}
.support-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.support-row {
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: 12px;
}
.support-without {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
}
.section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin-bottom: 10px;
}
.info-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  row-gap: 8px;
  align-items: start;
}
.info-key {
  font-size: 12px;
  color: var(--text-dim);
}
.info-val {
  font-size: 12px;
  color: var(--text);
}
.gpu-val {
  word-break: break-word;
  font-size: 11px;
}
.ok {
  color: #4caf50;
}
.warn {
  color: #e8a820;
}
</style>
