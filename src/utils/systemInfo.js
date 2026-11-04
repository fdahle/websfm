// What System info shows and the bug-report summary says (core/systemSummary.js), probed
// once per call: GPU, browser and OS, capabilities, storage. Nothing about the project
// beyond where it is stored.
import { version as appVersion } from '../../package.json'
import { featureReport } from '../core/browserSupport.js'
import { describeBrowser } from '../core/systemSummary.js'
import { isFolderProject } from '../core/io/folderProject.js'
import { browserCaps } from './browserCaps.js'
import * as opfs from './opfs.js'

// The renderer WebGL names, or the adapter WebGPU names where WebGL masks it. The
// extension constant is UNMASKED_RENDERER_WEBGL (the WEBGL_-prefixed spelling is the
// extension's name, not a member). Chrome may hide the extension behind privacy
// settings, hence the RENDERER fallback (generic, but never empty).
export async function gpuName() {
  let name = null
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      name = (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || null
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    } else name = 'No WebGL'
  } catch {
    /* best effort */
  }
  if ((!name || name === 'No WebGL') && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      const info = adapter && (adapter.info || (adapter.requestAdapterInfo && (await adapter.requestAdapterInfo())))
      name = [info?.description, info?.device, info?.vendor].find((s) => s) || name
    } catch {
      /* adapter info is best-effort */
    }
  }
  return name
}

async function browserHints() {
  try {
    const data = navigator.userAgentData
    if (!data?.getHighEntropyValues) return null
    return await data.getHighEntropyValues(['platform', 'platformVersion', 'fullVersionList'])
  } catch {
    return null
  }
}

/** project: the open project's index entry, or null. → the info systemSummaryLines reads */
export async function collectSystemInfo({ project = null } = {}) {
  const [caps, gpu, hints] = await Promise.all([browserCaps(), gpuName(), browserHints()])
  const { browser, os } = describeBrowser(navigator.userAgent, hints)
  const storage = { mode: project ? (isFolderProject(project) ? 'folder' : 'browser') : null }
  try {
    if (await opfs.isAvailable()) {
      const estimate = await opfs.getQuota()
      storage.used = estimate.usage ?? null
      storage.quota = estimate.quota ?? null
      storage.durable = await navigator.storage.persisted()
    }
  } catch {
    /* no estimate */
  }
  return {
    appVersion,
    browser,
    os,
    gpu,
    cores: navigator.hardwareConcurrency || null,
    deviceMemoryGB: caps.deviceMemoryGB,
    webgpu: caps.webgpu,
    webgl2: caps.webgl2,
    simd: caps.simd,
    isolated: caps.isolated,
    storage,
    support: featureReport(caps),
    missing: featureReport(caps)
      .filter((f) => !f.ok)
      .map((f) => f.label),
  }
}
