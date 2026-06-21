<script setup>
import { ref, onMounted } from 'vue'
import * as opfs from '../../utils/opfs.js'

const emit = defineEmits(['close'])

const gpu = ref('Detecting...')
const cores = ref(navigator.hardwareConcurrency || 'Unknown')
const memory = ref(navigator.deviceMemory ? `${navigator.deviceMemory} GB` : 'Unknown')
const webgl2 = ref(false)
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
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    gpu.value = ext ? gl.getParameter(ext.WEBGL_UNMASKED_RENDERER_WEBGL) : 'Unknown'
  } else {
    gpu.value = 'No WebGL'
  }

  // Minimal WASM module with a SIMD opcode (v128.const) to detect SIMD support
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
  <div class="modal-overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="About">
      <div class="modal-header">
        <span class="modal-title">About</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="app-section">
          <div class="app-name">websfm</div>
          <div class="app-desc">Open-source browser-based Structure from Motion</div>
          <div class="app-links">
            <a href="https://github.com/fdahle/websfm" target="_blank" rel="noopener">GitHub</a>
            <span class="link-sep">·</span>
            <a href="https://github.com/fdahle/websfm/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a>
          </div>
        </div>

        <div class="section-divider"></div>

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

          <span class="info-key">WASM SIMD</span>
          <span class="info-val" :class="wasmSimd ? 'ok' : 'warn'">{{ wasmSimd ? 'Supported' : 'Not supported' }}</span>
        </div>

        <div class="section-divider"></div>

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
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 380px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.modal-body {
  padding: 16px;
}

.app-section {
  text-align: center;
  padding: 8px 0 12px;
}

.app-name {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text);
  margin-bottom: 4px;
}

.app-desc {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 10px;
}

.app-links {
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.app-links a {
  color: var(--accent);
  text-decoration: none;
}

.app-links a:hover {
  text-decoration: underline;
}

.link-sep {
  color: var(--text-dim);
}

.section-divider {
  border: none;
  border-top: 1px solid var(--panel-border);
  margin: 12px 0;
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
  grid-template-columns: 110px 1fr;
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

.ok { color: #4caf50; }
.warn { color: #e8a820; }
</style>
