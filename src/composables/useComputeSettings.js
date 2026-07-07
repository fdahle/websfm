import { ref, watch } from 'vue'

// Machine-level compute limits (not per-run tuning), so they live in Settings and
// persist to localStorage — shared across every run rather than re-entered per modal.
//
// memBudgetGb: the dense pre-flight (Build Depth Maps, Step 5) refuses to start if
// the projected peak memory exceeds this, to stop the browser killing the tab. It's
// a property of *this machine's* RAM, not of a given project — hence a global setting.
// Key preserved from the old DepthMapsModal field so existing values migrate.
const BUDGET_KEY = 'websfm.dense.memBudgetGb'
const DEFAULT_BUDGET_GB = 2

const memBudgetGb = ref(Number(localStorage.getItem(BUDGET_KEY)) || DEFAULT_BUDGET_GB)

watch(memBudgetGb, (v) => {
  if (v > 0) localStorage.setItem(BUDGET_KEY, String(v))
})

export function useComputeSettings() {
  function setMemBudgetGb(v) {
    const n = Number(v)
    if (n > 0) memBudgetGb.value = n
  }
  return { memBudgetGb, setMemBudgetGb, DEFAULT_BUDGET_GB }
}
