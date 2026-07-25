<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { formatClock, formatRemaining } from '../../utils/timeFormat.js'

const props = defineProps({
  title:      { type: String, required: true },
  current:    { type: Number, default: 0 },
  total:      { type: Number, default: 0 },
  label:      { type: String, default: '' },
  unit:       { type: String, default: '' },
  // Authoritative, monotonic 0..1 bar value from usePipeline. `current`/`total`
  // remain the numeric readout only — they may re-count within a run.
  fraction:      { type: Number, default: 0 },
  indeterminate: { type: Boolean, default: false },
  complete:      { type: Boolean, default: false },
  cancelling:    { type: Boolean, default: false },
  cancelable:    { type: Boolean, default: false },
})
const emit = defineEmits(['cancel'])

// A bar that shows 100% while work is still running is what teaches users the bar
// lies, so in-flight progress is capped at 99% and only `complete` (set by
// usePipeline as it closes the modal) is allowed to fill it. Floor rather than
// round, for the same reason: never claim more progress than has happened.
const pct = computed(() => {
  if (props.complete) return 100
  return Math.min(99, Math.floor(props.fraction * 100))
})

// Sub-item progress for stages that emit a fractional `current` (dense Stage A ticks
// within an image's pyramid levels, fusion within a map's scanlines). The integer part
// is the item, the remainder is progress inside it — so a second thin bar comes free
// with no extra plumbing. Latched: a stage that never emits fractions never shows it.
const hasSubProgress = ref(false)
watch(() => props.current, (v) => {
  if (v > 0 && !Number.isInteger(v)) hasSubProgress.value = true
})
const subPct = computed(() => Math.round((props.current - Math.floor(props.current)) * 100))

// The count readout is noise when there is nothing to count (the single-call product
// ops report 1/1); those stages carry the label alone.
const showCount = computed(() => props.total > 1)

// Built here rather than interpolated in the template: Vue's whitespace: 'condense'
// strips a leading whitespace-only text node inside an element, so the space before
// the unit in `<template v-if="unit"> {{ unit }}</template>` was silently dropped and
// rendered "1 / 3images".
const countText = computed(() =>
  `${Math.floor(props.current)} / ${props.total}${props.unit ? ` ${props.unit}` : ''}`
)

// Elapsed-time timer. The modal is created fresh per run (v-if), so timing it
// from mount measures the run; the ticker just refreshes the display each second.
const startedAt = ref(0)
const now = ref(0)
let ticker = null

const elapsed = computed(() => formatClock((now.value - startedAt.value) / 1000))

// ── ETA: cumulative mean anchored, EMA-reactive, display-smoothed ────────────
// Estimated in FRACTION space rather than item counts, so one estimator serves every
// stage — including sparse SfM, whose phases have no common unit (cameras registered,
// then BA passes, then track-filter rounds) and whose sub-runs re-count from zero.
// Progress rate per second is highly variable (match pairs rejected early finish in a
// fraction of the time a fully-verified pair takes), so a naive trailing window swings
// wildly. We blend two estimators: the cumulative mean rate (fraction ÷ elapsed) is a
// stable anchor that integrates over the variance, while an exponential moving average
// of the recent rate reacts when the workload shifts phase. Remaining fraction ÷ the
// blended rate is the raw estimate, eased into `smoothedEta` so the countdown glides.
const lastStamp    = ref(0)  // wall-clock of the most recent advance
const lastFraction = ref(0)
const emaRate      = ref(0)  // exponential moving average of fraction per second
const smoothedEta  = ref(null)
const EMA_ALPHA    = 0.25    // weight of the newest sample in the EMA
const DISP_EASE     = 0.25   // per-tick easing of the displayed value toward the raw ETA
// Below this the sample is unrepresentative: on a big batch the first items are
// systematically the expensive ones (exhaustive matching visits an image's overlapping
// neighbours first), and extrapolating them shows an ETA wrong by an order of
// magnitude — worse than no number at all.
const MIN_FRACTION = 0.02
const MIN_ELAPSED_S = 3
// Count of genuine advances, not a rate — the overrun review below needs to tell
// "the model revised upward because the workload changed" from "the estimate is
// inflating because nothing is happening", and only an advance distinguishes them.
const advances = ref(0)
// A stall is evidence, and the EMA must hear it. The EMA is only fed by advances, so
// without this it holds the last (optimistic) rate for as long as the run is wedged,
// keeping half the blend pinned to a rate the run is no longer achieving. Folding in
// zero-rate samples on the tick decays it toward 0, which is exactly what "no progress
// for the last while" means; the cumulative rate still anchors the estimate.
const STALL_AFTER_S = 2

watch(() => props.fraction, (val) => {
  // `fraction` is monotonic by construction in usePipeline, so there is no restart
  // branch here any more — a sub-run re-counting is invisible at this layer.
  if (!(val > lastFraction.value)) return
  advances.value++
  const t = Date.now()
  if (lastStamp.value) {
    const dt = (t - lastStamp.value) / 1000
    if (dt > 0) {
      const rate = (val - lastFraction.value) / dt
      emaRate.value = emaRate.value > 0
        ? EMA_ALPHA * rate + (1 - EMA_ALPHA) * emaRate.value
        : rate
    }
  }
  lastStamp.value = t
  lastFraction.value = val
})

const etaSeconds = computed(() => {
  // Depend on `now` so the countdown ticks down between advances.
  void now.value
  const elapsedS = (now.value - startedAt.value) / 1000
  const f = props.fraction
  if (props.indeterminate || f <= 0) return null
  if (f < MIN_FRACTION || elapsedS < MIN_ELAPSED_S || !lastStamp.value) return null
  if (f >= 1) return 0
  const cumRate = f / elapsedS
  if (!(cumRate > 0)) return null
  // Blend the stable cumulative rate with the reactive EMA (equal weight once the EMA
  // has a sample; cumulative alone until then).
  const rate = emaRate.value > 0 ? 0.5 * cumRate + 0.5 * emaRate.value : cumRate
  return Math.max(0, (1 - f) / rate)
})

// Ease the displayed value toward the raw estimate so advances don't jolt it.
watch(etaSeconds, (v) => {
  if (v == null) { smoothedEta.value = null; return }
  smoothedEta.value = smoothedEta.value == null
    ? v
    : smoothedEta.value + (v - smoothedEta.value) * DISP_EASE
})

// ── Overrun: the estimate is falsified, not "reached zero" ────────────────────
// This must NOT be derived from the estimate's value. `etaSeconds` is recomputed from
// the current rates every tick rather than counting down a fixed deadline, so a stalled
// run makes `cumRate = f/elapsed` fall and the estimate *rise* — it heals upward and
// only approaches zero as f → 1. A `smoothedEta < 1` test therefore essentially never
// fires, while `formatRemaining` floors everything under a minute at "less than a
// minute" and parks there indefinitely. That combination is the failure the user sees:
// a confident sub-minute promise, minutes of further work, and no acknowledgement.
//
// So the estimate is treated as a *promise*: when one is made we record what it claimed
// and when. Blowing past it (plus a grace) is an overrun, regardless of what the
// current estimate says.
const overrunLatched = ref(false)
let promiseEta = null      // seconds the committed promise claimed
let promiseAt  = 0         // wall-clock it was made
let promiseAdvances = 0    // `advances` at commit time
// A promise may be re-armed when the model genuinely revises upward by this much — a
// run entering a slower phase (registration → bundle adjustment) is new information,
// not a missed deadline.
const REARM_FACTOR = 2
// How long past a promise before calling it wrong: a quarter of what was promised, but
// never less than 30 s (a 40 s estimate must not be flagged at 41 s) and never more
// than 5 minutes (a two-hour estimate should not buy half an hour of silence).
const overrunGraceS = (etaS) => Math.min(300, Math.max(30, etaS * 0.25))

function commitPromise(etaS) {
  promiseEta = etaS
  promiseAt = Date.now()
  promiseAdvances = advances.value
  overrunLatched.value = false
}

// Declared after the easing watcher so it observes this tick's `smoothedEta`, not the
// previous one (watchers fire in creation order within a flush).
watch(now, () => {
  // Stall decay: fold a zero-rate sample into the EMA once the run goes quiet. Scaled
  // by the tick so the decay rate is wall-clock-based, not tick-count-based.
  if (emaRate.value > 0 && lastStamp.value && (Date.now() - lastStamp.value) / 1000 > STALL_AFTER_S) {
    emaRate.value *= Math.max(0, 1 - EMA_ALPHA * 0.25)
  }

  const v = smoothedEta.value
  if (v == null || props.complete || props.fraction >= 1) return
  if (promiseEta == null) { commitPromise(v); return }

  const overdueBy = (Date.now() - promiseAt) / 1000 - (promiseEta + overrunGraceS(promiseEta))
  if (overdueBy <= 0) {
    // Still within the promise: a large upward revision replaces it silently.
    if (v > promiseEta * REARM_FACTOR) commitPromise(v)
    return
  }
  // Overdue. Only a *fresh advance* may re-arm the promise, so a wedged run's
  // self-inflating estimate can't quietly paper over the miss it just made.
  if (advances.value > promiseAdvances && v > promiseEta * REARM_FACTOR) { commitPromise(v); return }
  overrunLatched.value = true
})

const overrun = computed(() =>
  !props.complete && props.fraction < 1 && overrunLatched.value
)

const etaText = computed(() => {
  if (props.complete || props.fraction >= 1) return null
  if (smoothedEta.value == null) return null
  if (overrun.value) return null
  // Coarse on purpose — the estimate does not justify second-level precision, and a
  // bucketed value stops the number twitching on every 250 ms tick.
  return formatRemaining(smoothedEta.value)
})

// The bucketing above is not enough on its own: the eased estimate drifts across a
// bucket boundary continuously, so a run sitting near 4.5 minutes flips "4 minutes" /
// "5 minutes" every tick. Hold a shown value for at least this long before replacing
// it — the displayed number is then wrong by at most one bucket for a few seconds,
// which is far cheaper than a countdown that never stands still.
const ETA_HOLD_MS = 15000
const eta = ref(null)
let etaShownAt = 0

// Driven by the ticker as well as the estimate: a suppressed change must still land
// once the hold expires, and by then the candidate string may have stopped changing
// (so a watcher on the candidate alone would never fire again).
watch(() => [etaText.value, now.value], () => {
  const v = etaText.value
  // Appearing or disappearing is a state change, not a twitch — never delay it.
  if (v == null || eta.value == null) {
    if (v !== eta.value) { eta.value = v; etaShownAt = Date.now() }
    return
  }
  if (v === eta.value) return
  if (Date.now() - etaShownAt < ETA_HOLD_MS) return
  eta.value = v
  etaShownAt = Date.now()
}, { immediate: true })

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
          <div
            v-if="indeterminate && !complete"
            class="progress-fill indeterminate"
            :class="{ cancelling }"
          ></div>
          <div
            v-else
            class="progress-fill"
            :class="{ cancelling, complete }"
            :style="{ width: pct + '%' }"
          ></div>
        </div>
        <span class="progress-pct">{{ indeterminate && !complete ? '' : pct + '%' }}</span>
      </div>
      <!-- Sub-item bar: progress within the current image / depth map. -->
      <div v-if="hasSubProgress && !indeterminate && !complete" class="progress-track sub">
        <div class="progress-fill sub" :class="{ cancelling }" :style="{ width: subPct + '%' }"></div>
      </div>
      <!-- The phase label carries as much weight as the number: on a long dense run
           "Filtering depth maps (cross-view)" is more reassuring than "63%". -->
      <div v-if="label" class="progress-phase" :title="label">{{ label }}</div>
      <div class="progress-sub">
        <span class="progress-count">
          <template v-if="showCount">{{ countText }} · </template>
          <span class="progress-time" title="Elapsed time">⏱ {{ elapsed }}</span>
          <!-- The separator carries a literal &nbsp;: the whitespace between these two
               elements is a whitespace-only text node containing a newline, which Vue's
               whitespace: 'condense' removes outright, rendering "0:42· 4 minutes left".
               Same trap as countText above. -->
          <span v-if="eta" class="progress-time" title="Estimated time remaining">&nbsp;· {{ eta }} left</span>
          <span v-else-if="overrun" class="progress-time" title="The run has exceeded its estimate">&nbsp;· longer than expected</span>
        </span>
      </div>
      <div v-if="cancelable" class="progress-actions">
        <button class="btn-cancel" :disabled="cancelling" @click="emit('cancel')">
          {{ cancelling ? 'Cancelling…' : 'Cancel' }}
        </button>
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
  /* Ease-out rather than linear: the fill glides into each new value instead of
     stepping, which reads as faster for the same elapsed time. */
  transition: width 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}

/* The closing 100%: slower and deliberate, so the run visibly lands. */
.progress-fill.complete {
  transition: width 0.3s ease-out;
}

/* A cancelled run is not progressing — stop pretending it is. */
.progress-fill.cancelling {
  background: var(--text-dim);
  transition: none;
}

/* No countable work: a shuttle instead of a determinate fill frozen at 0%. */
.progress-fill.indeterminate {
  width: 35%;
  transition: none;
  animation: progress-shuttle 1.4s ease-in-out infinite;
}

@keyframes progress-shuttle {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(286%); } /* 100/35 — travels the full track */
}

/* Sub-item bar: thinner and dimmer, so it reads as subordinate to the main one. */
.progress-track.sub {
  height: 3px;
  margin-top: -6px;
}

.progress-fill.sub {
  background: var(--accent);
  opacity: 0.45;
}

.progress-phase {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: -4px;
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

.btn-cancel:hover:not(:disabled) {
  background: var(--hover-bg);
  color: var(--text);
}

.btn-cancel:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
