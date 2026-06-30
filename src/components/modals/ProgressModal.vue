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

function formatClock(secs) {
  const s = Math.max(0, Math.round(secs))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// Elapsed-time timer. The modal is created fresh per run (v-if), so timing it
// from mount measures the run; the ticker just refreshes the display each second.
const startedAt = ref(0)
const now = ref(0)
let ticker = null

const elapsed = computed(() => formatClock((now.value - startedAt.value) / 1000))

// ── ETA via rolling average ────────────────────────────────────────────────
// Record the wall-clock time each time `current` advances, then average the gaps
// between the most recent completions. A rolling window (not the run-wide mean)
// keeps the estimate responsive when items speed up or slow down. ETA = mean gap
// × items remaining. Shown only once there's enough signal to be meaningful.
const WINDOW = 10
const stamps = ref([])   // timestamps of recent `current` increments

watch(() => props.current, (val, prev) => {
  // Reset if the counter restarts (e.g. a new phase reusing the same modal).
  if (val < (prev ?? 0)) { stamps.value = []; return }
  if (val > (prev ?? 0)) {
    stamps.value.push(Date.now())
    if (stamps.value.length > WINDOW + 1) stamps.value.shift()
  }
})

const etaSeconds = computed(() => {
  // Depend on `now` so the countdown ticks down between completions.
  void now.value
  const s = stamps.value
  if (props.total <= 0 || s.length < 2) return null
  const remaining = props.total - props.current
  if (remaining <= 0) return 0
  const span = (s[s.length - 1] - s[0]) / 1000
  const perItem = span / (s.length - 1)
  if (!(perItem > 0)) return null
  // Subtract time already spent on the in-flight item so the estimate decays.
  const sinceLast = (now.value - s[s.length - 1]) / 1000
  return Math.max(0, perItem * remaining - sinceLast)
})

const eta = computed(() => etaSeconds.value == null ? null : formatClock(etaSeconds.value))

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
          {{ current }} / {{ total }}
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
