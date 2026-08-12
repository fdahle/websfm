<script setup>
// Hardware / capability / storage diagnostics. Split out of the About modal
// (which is now identity + acknowledgments + licenses) because this is a
// different job: what you point a user at when debugging "what GPU / is SIMD on
// / how much OPFS is left".
import { ref, onMounted } from 'vue'
import * as opfs from '../../utils/opfs.js'
import ModalShell from './ui/ModalShell.vue'

const emit = defineEmits(['close'])

const gpu = ref('Detecting…')
const cores = ref(navigator.hardwareConcurrency || 'Unknown')
const memory = ref(navigator.deviceMemory ? `${navigator.deviceMemory} GB` : 'Unknown')
const webgl2 = ref(false)
const webgpu = ref(false)
const wasmSimd = ref(false)

const opfsAvailable = ref(false)
const opfsDurable = ref(false)
const opfsUsed = ref(null)
const opfsQuota = ref(null)

function fmtBytes(n) {
  if (n == null) return '—'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

onMounted(async () => {
  const canvas = document.createElement('canvas')
  const gl2 = canvas.getContext('webgl2')
  webgl2.value = !!gl2

  const gl = gl2 || canvas.getContext('webgl')
  if (gl) {
    // The extension constant is UNMASKED_RENDERER_WEBGL — the WEBGL_-prefixed
    // spelling is the *extension* name, not a member, so reading it yields
    // undefined and getParameter(undefined) returns null (a blank field, no error).
    // Chrome also hides the extension behind privacy settings, hence the RENDERER
    // fallback (generic, but never empty).
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      || gl.getParameter(gl.RENDERER)
    gpu.value = renderer || 'Unknown'
  } else {
    gpu.value = 'No WebGL'
  }

  webgpu.value = !!navigator.gpu
  // WebGPU reports the real adapter on engines that mask it in WebGL.
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      const info = adapter && (adapter.info || (adapter.requestAdapterInfo && await adapter.requestAdapterInfo()))
      const desc = [info?.description, info?.device, info?.vendor].find(s => s)
      if (desc && (!gpu.value || gpu.value === 'Unknown')) gpu.value = desc
    } catch { /* adapter info is best-effort */ }
  }

  // Minimal WASM module with a SIMD opcode (v128.const) to detect SIMD support.
  const simdBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x0a, 0x01, 0x08, 0x00, 0xfd, 0x0c,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x0b,
  ])
  wasmSimd.value = WebAssembly.validate(simdBytes)

  opfsAvailable.value = await opfs.isAvailable()
  if (opfsAvailable.value) {
    opfsDurable.value = await navigator.storage.persisted()
    const estimate = await opfs.getQuota()
    opfsUsed.value = estimate.usage ?? null
    opfsQuota.value = estimate.quota ?? null
  }
})
</script>

<template>
  <ModalShell title="System info" aria-label="System info" @close="emit('close')">
    <div class="section-label">System</div>
    <div class="info-grid">
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
        <span class="info-val">{{ fmtBytes(opfsUsed) }}</span>

        <span class="info-key">Quota</span>
        <span class="info-val">{{ fmtBytes(opfsQuota) }}</span>
      </template>
    </div>

    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.section-divider {
  border: none;
  border-top: 1px solid var(--panel-border);
  margin: 14px 0;
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
.info-key { font-size: 12px; color: var(--text-dim); }
.info-val { font-size: 12px; color: var(--text); }
.gpu-val { word-break: break-word; font-size: 11px; }
.ok { color: #4caf50; }
.warn { color: #e8a820; }
</style>
