import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { MODELS, MODEL_CACHE_NAME, modelUrl, toMB, isRedistributable } from '../core/models/registry.js'
import { isModelCached, modelBytesProblem, badModelError } from '../core/models/modelCache.js'
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
    for (const id of (request.value?.ids ?? []).filter((i) => isRedistributable(i))) {
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
    // A missing file can still answer 200 with the host's index.html. Refuse an
    // HTML content type before streaming; the bytes are checked again below.
    const contentType = resp.headers.get('content-type') ?? ''
    const htmlType = modelBytesProblem({ contentType })
    if (htmlType) throw badModelError(MODELS[id].label, url, htmlType)
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

    const problem = modelBytesProblem({
      head: new Uint8Array(await bytes.slice(0, 64).arrayBuffer()),
      size: bytes.size,
    })
    if (problem) throw badModelError(MODELS[id].label, url, problem)

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

    // A non-redistributable model (registry.js) is never downloaded from this
    // site: the user fetches it upstream and hands it over (provideModelFile).
    const items = missing.map((id) => {
      const m = MODELS[id]
      return {
        id, label: m.label, approxBytes: m.approxBytes, license: m.license, licenseUrl: m.licenseUrl,
        userSupplied: !isRedistributable(id), sourceUrl: m.sourceUrl, sourceFile: m.sourceFile ?? m.file,
        ready: false, fileError: '',
      }
    })
    const totalBytes = items.filter((m) => !m.userSupplied).reduce((s, m) => s + m.approxBytes, 0)
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
        // User-supplied items are already cached by provideModelFile.
        for (const id of missing.filter((i) => isRedistributable(i))) {
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

  // Every user-supplied item of the open request has been handed over.
  const suppliedAll = computed(() => (request.value?.items ?? []).every((m) => !m.userSupplied || m.ready))

  function approve() { if (!downloading.value && suppliedAll.value) decision?.(true) }
  function decline() { if (!downloading.value) decision?.(false) }

  /**
   * Accept a model file the user downloaded themselves (a non-redistributable
   * model, see registry.js) and cache it under the model's URL — exactly where a
   * download would have put it, so the worker's loaders need no other path. When
   * that completes the request and nothing is left to download, the run continues
   * without a second click. Returns true when the file was accepted.
   */
  async function provideModelFile(id, file) {
    const item = request.value?.items.find((m) => m.id === id)
    if (item) item.fileError = ''
    try {
      const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())
      const problem = modelBytesProblem({ head, size: file.size })
        // An ONNX ModelProto opens with field 1 (ir_version) as a varint: 0x08.
        ?? (head[0] !== 0x08 ? 'it does not start like an ONNX model' : null)
      if (problem) throw new Error(`"${file.name}" is not an ONNX model (${problem})`)
      const cache = await caches.open(MODEL_CACHE_NAME)
      await cache.put(modelUrl(id), new Response(file, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
      }))
      log(`Model provided: ${MODELS[id].label} from "${file.name}" (${toMB(file.size)} MB)`, 'info', 'Models')
    } catch (err) {
      const msg = String(err?.message ?? err)
      if (item) item.fileError = msg
      log(`Model file rejected: ${msg}`, 'error', 'Models')
      return false
    }
    if (item) item.ready = true
    if (request.value && request.value.items.every((m) => m.ready)) decision?.(true)
    return true
  }

  return {
    request, downloading, progress, errorMsg, totalLoaded, suppliedAll,
    ensureReady, approve, decline, provideModelFile, toMB,
  }
})
