import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { MODELS, MODEL_CACHE_NAME, modelUrl, toMB } from '../core/models/registry.js'
import { isModelCached } from '../core/models/modelCache.js'
import { useLog } from '../composables/useLog.js'

// Main-thread owner of the on-demand model download flow.
//
// The learned backends (SuperPoint / LightGlue / SAM2) need large ONNX weights
// that are NOT shipped in the repo (see core/models/registry.js). Before a store
// or component dispatches a learned op, it awaits `ensureReady([...ids])`. If the
// weights are already in Cache Storage this resolves immediately; otherwise it
// opens a consent modal (ModelDownloadModal.vue reads this store's state), and on
// approval streams each file into Cache Storage with progress. The compute worker
// then reads the cached bytes (core/models/modelCache.js) — no re-download, no
// re-consent.
//
// Plain (non-project-scoped) Pinia store: nothing here persists to a project. The
// download persists in the browser's Cache Storage, which outlives projects.
export const useModelsStore = defineStore('models', () => {
  const { log } = useLog()

  // The active consent/progress request, or null when idle. Shape:
  //   { ids, items: [{ id, label, approxBytes, license }], totalBytes }
  const request = ref(null)
  // Downloading phase (after the user approves). Per-id progress { loaded, total }.
  const downloading = ref(false)
  const progress = ref({})            // id → { loaded, total }
  const errorMsg = ref('')

  // Set while a request is open so a second caller (e.g. a queued op) awaits the
  // same modal rather than opening a second one for overlapping ids.
  let pending = null                  // { promise, resolve, ids }
  let decision = null                 // resolver for approve()/decline()

  const totalLoaded = computed(() => {
    let l = 0, t = 0
    for (const id of request.value?.ids ?? []) {
      const p = progress.value[id]
      if (p) { l += p.loaded; t += p.total }
      else t += MODELS[id]?.approxBytes ?? 0
    }
    return { loaded: l, total: t }
  })

  // Stream one model into Cache Storage, updating progress as bytes arrive.
  async function download(id) {
    const url = modelUrl(id)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`${MODELS[id].label}: HTTP ${resp.status}`)
    const total = Number(resp.headers.get('content-length')) || MODELS[id].approxBytes
    progress.value = { ...progress.value, [id]: { loaded: 0, total } }

    const reader = resp.body?.getReader?.()
    let bytes
    if (reader) {
      const chunks = []
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.length
        progress.value = { ...progress.value, [id]: { loaded, total: Math.max(total, loaded) } }
      }
      bytes = new Blob(chunks)
    } else {
      // No streaming body (unlikely) — fall back to a whole-buffer read.
      bytes = await resp.blob()
      progress.value = { ...progress.value, [id]: { loaded: bytes.size, total: bytes.size } }
    }

    const cache = await caches.open(MODEL_CACHE_NAME)
    await cache.put(url, new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.size) },
    }))
    log(`Model cached: ${MODELS[id].label} (${toMB(bytes.size * 1)} MB)`, 'info', 'Models')
  }

  // Which of `ids` are not yet in Cache Storage.
  async function missingOf(ids) {
    const miss = []
    for (const id of ids) {
      if (!MODELS[id]) throw new Error(`Unknown model id: ${id}`)
      if (!(await isModelCached(modelUrl(id)))) miss.push(id)
    }
    return miss
  }

  /**
   * Ensure every model id in `ids` is present in Cache Storage, prompting the
   * user to download the missing ones. Returns true when all are ready, false if
   * the user declined (the caller should abort its op cleanly).
   */
  async function ensureReady(ids) {
    ids = [...new Set(ids)]
    const missing = await missingOf(ids)
    if (missing.length === 0) return true

    // Coalesce onto an in-flight request when it already covers what we need.
    if (pending) {
      const covered = missing.every((id) => pending.ids.includes(id))
      if (covered) return pending.promise
    }

    const items = missing.map((id) => ({ id, label: MODELS[id].label, approxBytes: MODELS[id].approxBytes, license: MODELS[id].license }))
    const totalBytes = items.reduce((s, m) => s + m.approxBytes, 0)
    errorMsg.value = ''
    progress.value = {}
    request.value = { ids: missing, items, totalBytes }

    const promise = new Promise((resolve) => { decision = resolve }).then(async (approved) => {
      if (!approved) {
        log('Model download declined — this feature needs its weights to run.', 'warn', 'Models')
        request.value = null
        return false
      }
      downloading.value = true
      try {
        for (const id of missing) {
          log(`Downloading ${MODELS[id].label} (~${toMB(MODELS[id].approxBytes)} MB)…`, 'info', 'Models')
          await download(id)
        }
        return true
      } catch (err) {
        errorMsg.value = String(err?.message ?? err)
        log(`Model download failed: ${errorMsg.value}`, 'error', 'Models')
        return false
      } finally {
        downloading.value = false
        request.value = null
      }
    })

    pending = { promise, ids: missing }
    promise.finally(() => { if (pending?.promise === promise) pending = null })
    return promise
  }

  function approve() { if (!downloading.value) decision?.(true) }
  function decline() { if (!downloading.value) decision?.(false) }

  return {
    request, downloading, progress, errorMsg, totalLoaded,
    ensureReady, approve, decline, toMB,
  }
})
