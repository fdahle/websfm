<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  title:      { type: String, required: true },
  current:    { type: Number, default: 0 },
  total:      { type: Number, default: 0 },
  label:      { type: String, default: '' },
  cancelable: { type: Boolean, default: false },
})
const emit = defineEmits(['cancel'])

const pct = computed(() =>
  props.total > 0 ? Math.round((props.current / props.total) * 100) : 0
)

// Under an hour: M:SS. From an hour up: "Xh Ym" — a long run otherwise renders
// as e.g. "9000:00", unbounded minutes that read as anything but 150 hours.
function formatClock(secs) {
  const s = Math.max(0, Math.round(secs))
  if (s >= 3600) {
    // Floor the minutes so a value like 7170 s can't round up to "1h 60m".
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// Elapsed-time timer. The modal is created fresh per run (v-if), so timing it
// from mount measures the run; the ticker just refreshes the display each second.
const startedAt = ref(0)
const now = ref(0)
let ticker = null

const elapsed = computed(() => formatClock((now.value - startedAt.value) / 1000))

// ── ETA: cumulative mean anchored, EMA-reactive, display-smoothed ────────────
// Per-item time is highly variable here (e.g. match pairs rejected early finish in
// a fraction of the time a fully-verified pair takes), so a naive trailing window
// swings wildly. We blend two estimators: the cumulative mean (elapsed ÷ completed)
// is a stable anchor that integrates over the variance, while an exponential moving
// average of recent per-item times reacts when the workload shifts phase (e.g. the
// run crosses from cheap rejects into expensive verified pairs). The blend of the
// two, times the remaining count, minus the time already spent on the in-flight
// item, is the raw estimate — then eased into `smoothedEta` so the shown countdown
// glides instead of jumping at each completion.
const lastStamp   = ref(0)  // wall-clock of the most recent completion
const emaPerItem  = ref(0)  // exponential moving average of per-item seconds
const smoothedEta = ref(null)
const EMA_ALPHA   = 0.25    // weight of the newest sample in the EMA
const DISP_EASE   = 0.25    // per-tick easing of the displayed value toward the raw ETA

watch(() => props.current, (val, prev) => {
  const p = prev ?? 0
  // Reset if the counter restarts (e.g. a new phase reusing the same modal).
  if (val < p) {
    startedAt.value = Date.now(); lastStamp.value = 0
    emaPerItem.value = 0; smoothedEta.value = null
    return
  }
  if (val > p) {
    const t = Date.now()
    if (lastStamp.value) {
      // Divide by the number of items closed since the last stamp (usually 1).
      const dt = (t - lastStamp.value) / 1000 / (val - p)
      if (dt >= 0) {
        emaPerItem.value = emaPerItem.value > 0
          ? EMA_ALPHA * dt + (1 - EMA_ALPHA) * emaPerItem.value
          : dt
      }
    }
    lastStamp.value = t
  }
})

const etaSeconds = computed(() => {
  // Depend on `now` so the countdown ticks down between completions.
  void now.value
  const remaining = props.total - props.current
  // Withhold the estimate until a representative sample: on a big batch the first
  // items are systematically the expensive ones (exhaustive matching visits an
  // image's overlapping neighbours first), and extrapolating them 4000× over
  // shows an ETA wrong by an order of magnitude — worse than no number.
  const minSamples = Math.min(30, Math.max(2, Math.ceil(props.total * 0.01)))
  if (props.total <= 0 || props.current < minSamples || !lastStamp.value) return null
  if (remaining <= 0) return 0
  const cumMean = ((lastStamp.value - startedAt.value) / 1000) / props.current
  if (!(cumMean > 0)) return null
  // Blend the stable cumulative mean with the reactive EMA (equal weight once the
  // EMA has a sample; cumulative mean alone until then).
  const perItem = emaPerItem.value > 0 ? 0.5 * cumMean + 0.5 * emaPerItem.value : cumMean
  // Subtract time already spent on the in-flight item so the estimate decays.
  const sinceLast = (now.value - lastStamp.value) / 1000
  return Math.max(0, perItem * remaining - sinceLast)
})

// Ease the displayed value toward the raw estimate so completions don't jolt it.
watch(etaSeconds, (v) => {
  if (v == null) { smoothedEta.value = null; return }
  smoothedEta.value = smoothedEta.value == null
    ? v
    : smoothedEta.value + (v - smoothedEta.value) * DISP_EASE
})

const eta = computed(() => smoothedEta.value == null ? null : formatClock(smoothedEta.value))

onMounted(() => {
  startedAt.value = Date.now()
  now.value = startedAt.value
  ticker = setInterval(() => { now.value = Date.now() }, 250)
})

onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})
</script>

<template>
  <div class="overlay">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">{{ title }}</div>
      <div class="progress-row">
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: pct + '%' }"></div>
        </div>
        <span class="progress-pct">{{ pct }}%</span>
      </div>
      <div class="progress-sub">
        <span class="progress-count">
          {{ Math.floor(current) }} / {{ total }}
          <span class="progress-time" title="Elapsed time">· ⏱ {{ elapsed }}</span>
          <span v-if="eta" class="progress-time" title="Estimated time remaining">· ~{{ eta }} left</span>
        </span>
        <span v-if="label" class="progress-label" :title="label">{{ label }}</span>
      </div>
      <div v-if="cancelable" class="progress-actions">
        <button class="btn-cancel" @click="emit('cancel')">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  width: 340px;
  max-width: 90vw;
  padding: 22px 24px 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-track {
  flex: 1;
  height: 6px;
  background: var(--hover-bg);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.2s ease;
}

.progress-pct {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  width: 34px;
  text-align: right;
  flex-shrink: 0;
}

.progress-sub {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.progress-count {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.progress-time {
  color: var(--text-dim);
  white-space: nowrap;
}

.progress-label {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
  text-align: right;
}

.progress-actions {
  display: flex;
  justify-content: flex-end;
}

.btn-cancel {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 4px 14px;
  cursor: pointer;
}

.btn-cancel:hover {
  background: var(--hover-bg);
  color: var(--text);
}
</style>
