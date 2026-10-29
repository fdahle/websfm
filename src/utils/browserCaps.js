// Probes what this browser offers, for core/browserSupport.js. Once per page: the
// answers do not change while it is open.
import { bigArrayCaps } from '../core/bigArray.js'
import { folderStorageSupported } from '../core/io/folderProject.js'

// The smallest module with a SIMD instruction: a function returning v128.const 0.
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00,
  0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x0b,
])

export function wasmSimdSupported() {
  try {
    return WebAssembly.validate(SIMD_PROBE)
  } catch {
    return false
  }
}

async function hasStorage() {
  try {
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}

async function hasWebGpu() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()))
  } catch {
    return false
  }
}

function hasWebGl2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
}

let probe = null

/** @returns {Promise<object>} the caps core/browserSupport.js reads */
export function browserCaps() {
  probe ??= (async () => {
    const mem = bigArrayCaps()
    const deviceMemoryGB = Number(navigator.deviceMemory)
    return {
      storage: await hasStorage(),
      webgl2: hasWebGl2(),
      webgpu: await hasWebGpu(),
      isolated: globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined',
      sharedMemory: mem.shared,
      simd: wasmSimdSupported(),
      memory64: mem.memory64,
      folderAccess: folderStorageSupported(),
      savePicker: typeof window.showSaveFilePicker === 'function',
      deviceMemoryGB: Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0 ? deviceMemoryGB : null,
    }
  })()
  return probe
}
