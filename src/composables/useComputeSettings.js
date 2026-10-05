import { computed, ref, watch } from 'vue'
import { DEFAULT_BUDGET_BYTES, deviceBudget } from '../core/dense/memBudget.js'
import { recommendSettings } from '../core/recommend.js'
import { useLog } from './useLog.js'
import { configureWorkerPoolSize, MAX_POOL_SIZE } from '../workers/computeClient.js'

// Machine-level compute limits (not per-run tuning), so they live in Settings and
// persist to localStorage — shared across every run rather than re-entered per modal.
//
// memBudgetGb: the dense pre-flight (Build Depth Maps, Step 5) refuses to start if
// the projected peak memory exceeds this, to stop the browser killing the tab. It's
// a property of *this machine's* RAM, not of a given project — hence a global setting.
// Key preserved from the old DepthMapsModal field so existing values migrate.
const BUDGET_KEY = 'websfm.dense.memBudgetGb'
const GiB = 1024 ** 3
const DEFAULT_BUDGET_GB = DEFAULT_BUDGET_BYTES / GiB

// Read browser-only hardware signals here, on the main thread; core receives only
// injected numbers and remains DOM-free. Both APIs are intentionally optional.
const deviceBudgetInfo = deviceBudget({
  deviceMemoryGB: typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) : null,
  jsHeapLimitBytes: typeof performance !== 'undefined'
    ? Number(performance.memory?.jsHeapSizeLimit)
    : null,
})

const storedBudgetGb = Number(localStorage.getItem(BUDGET_KEY))
const hasStoredBudget = Number.isFinite(storedBudgetGb) && storedBudgetGb > 0
const memBudgetGb = ref(hasStoredBudget ? storedBudgetGb : deviceBudgetInfo.budgetBytes / GiB)
const memBudgetAuto = ref(!hasStoredBudget)
const memBudgetBytes = computed(() => Math.max(0.25, Number(memBudgetGb.value) || DEFAULT_BUDGET_GB) * GiB)

// U2/U3 consume the real device-memory reading, not the user's safety-limit
// override: recommendation quality describes hardware, while memBudgetBytes is a
// hard pre-flight gate the user remains free to tighten or raise.
const recommendationBudget = Object.freeze({
  deviceMemoryGB: deviceBudgetInfo.deviceMemoryGB,
  source: deviceBudgetInfo.source,
})

let budgetLogged = false

// useGpu: prefer the experimental WebGPU backends (brute-force + LightGlue matching,
// PatchMatch depth maps) automatically on capable browsers. A property of *this browser/GPU*,
// not of a project or run — so it lives here rather than duplicated as a per-modal
// checkbox. Both consumers fall back to CPU automatically when adapter acquisition or
// an operation fails, and an explicit user opt-out remains persisted.
const GPU_KEY = 'websfm.compute.useGpu'
const storedGpu = localStorage.getItem(GPU_KEY)
// Prefer WebGPU on first use when the browser exposes it. The worker still performs
// the authoritative adapter/device probe and safely falls back to WASM, while a
// stored true/false remains an explicit user choice on later visits.
const gpuApiAvailable = typeof navigator !== 'undefined' && !!navigator.gpu
const useGpu = ref(storedGpu == null ? gpuApiAvailable : storedGpu === 'true')

watch(useGpu, (v) => localStorage.setItem(GPU_KEY, String(!!v)))

// 0 means automatic (one worker per available core minus the UI thread, capped
// at MAX_POOL_SIZE). A lower manual value is useful on memory-constrained devices.
const WORKERS_KEY = 'websfm.compute.workerCount'
const storedWorkers = Number(localStorage.getItem(WORKERS_KEY))
const workerCount = ref(storedWorkers > 0 ? Math.min(MAX_POOL_SIZE, Math.round(storedWorkers)) : 0)

export function useComputeSettings() {
  if (!budgetLogged) {
    const { log } = useLog()
    const suffix = hasStoredBudget
      ? ` Using saved manual safety limit ${storedBudgetGb} GB.`
      : ' Using it as the automatic dense-run safety limit.'
    log(`${deviceBudgetInfo.note}${suffix}`, 'info', 'Compute')
    budgetLogged = true
  }

  function setMemBudgetGb(v) {
    const n = Number(v)
    if (n > 0) {
      memBudgetGb.value = n
      memBudgetAuto.value = false
      localStorage.setItem(BUDGET_KEY, String(n))
    }
  }
  function resetMemBudgetAuto() {
    localStorage.removeItem(BUDGET_KEY)
    memBudgetGb.value = deviceBudgetInfo.budgetBytes / GiB
    memBudgetAuto.value = true
  }
  // Canonical U2 bridge: callers provide the metadata-only profile; this
  // composable supplies the hardware signal C1 owns.
  function recommendForDataset(profile) {
    return recommendSettings(profile, recommendationBudget)
  }
  function setUseGpu(v) { useGpu.value = !!v }
  function setWorkerCount(v) {
    const n = Number(v)
    const next = n > 0 ? Math.max(1, Math.min(MAX_POOL_SIZE, Math.round(n))) : 0
    workerCount.value = next
    localStorage.setItem(WORKERS_KEY, String(next))
    return configureWorkerPoolSize(next)
  }
  return {
    memBudgetGb, memBudgetBytes, memBudgetAuto,
    setMemBudgetGb, resetMemBudgetAuto, DEFAULT_BUDGET_GB,
    deviceBudgetInfo, recommendationBudget, recommendForDataset,
    useGpu, setUseGpu,
    workerCount, setWorkerCount, MAX_POOL_SIZE,
  }
}
