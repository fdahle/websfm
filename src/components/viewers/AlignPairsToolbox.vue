<script setup>
import { computed } from 'vue'
import FloatingToolbox from './FloatingToolbox.vue'
import { fitPointPairs, rotationAngle } from '../../core/products/cloudAlign.js'

// Align by Point Pairs (Tools ▸ Point Cloud ▾): click a point in the cloud to MOVE,
// then the same feature in the REFERENCE, ≥ 3 times; the similarity (or rigid)
// fit is live and Apply adds the aligned copy. The rough alignment ICP needs, and
// enough on its own when the clicks are good. The 3D view does the picking
// (Viewer3D pickMode); this toolbox holds the pairs.
const props = defineProps({
  clouds: { type: Array, default: () => [] },       // movable: dense clouds
  references: { type: Array, default: () => [] },   // dense clouds + meshes
  sourceId: { type: String, default: null },
  referenceId: { type: String, default: null },
  // [{ src: [x,y,z], dst: [x,y,z] | null }] — the last may be half-done.
  pairs: { type: Array, default: () => [] },
  allowScale: { type: Boolean, default: false },
})
const emit = defineEmits(['update:sourceId', 'update:referenceId', 'update:allowScale', 'undo', 'clear', 'apply', 'close'])

const complete = computed(() => props.pairs.filter((p) => p.src && p.dst))
const expecting = computed(() => {
  const last = props.pairs[props.pairs.length - 1]
  return last && !last.dst ? 'reference' : 'source'
})
const nameOf = (list, id) => list.find((c) => c.id === id)?.name ?? '—'
const fit = computed(() => {
  if (complete.value.length < 3) return null
  try {
    return fitPointPairs(complete.value.map((p) => ({ src: p.src, dst: p.dst })), { scale: props.allowScale })
  } catch (err) {
    return { error: err.message }
  }
})
const summary = computed(() => {
  const f = fit.value
  if (!f || f.error) return ''
  const deg = rotationAngle(f.transform.R) * 180 / Math.PI
  return `RMS ${f.rms.toPrecision(3)} · rotation ${deg.toFixed(2)}°${props.allowScale ? ` · scale ${f.transform.scale.toFixed(5)}` : ''}`
})
</script>

<template>
  <FloatingToolbox id="align-pairs" title="Align by point pairs" :width="300" close-title="Cancel point-pair alignment (Esc)" @close="emit('close')">
    <label class="tb-field">
      <span>Move</span>
      <select class="tb-input" :value="sourceId" @change="emit('update:sourceId', $event.target.value)">
        <option v-for="c in clouds" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <span></span>
    </label>
    <label class="tb-field">
      <span>Onto</span>
      <select class="tb-input" :value="referenceId" @change="emit('update:referenceId', $event.target.value)">
        <option v-for="c in references" :key="c.id" :value="c.id" :disabled="c.id === sourceId">{{ c.name }}</option>
      </select>
      <span></span>
    </label>
    <div class="tb-sep" />
    <div class="tb-line">
      Click point {{ complete.length + 1 }} in
      <strong :class="expecting">{{ expecting === 'source' ? nameOf(clouds, sourceId) : nameOf(references, referenceId) }}</strong>
    </div>
    <ol v-if="pairs.length" class="pairs">
      <li v-for="(p, i) in pairs" :key="i">
        <span class="dot source"></span><span class="dot reference" :class="{ pending: !p.dst }"></span>
        pair {{ i + 1 }}
        <span v-if="fit?.residuals && p.dst" class="res">{{ fit.residuals[complete.indexOf(p)]?.toPrecision(3) }}</span>
      </li>
    </ol>
    <div class="tb-hint">
      {{ complete.length < 3 ? `${3 - complete.length} more pair(s) needed. Pick well-spread, sharp features.`
        : (fit?.error || summary) }}
    </div>
    <label class="tb-row tb-check">
      <input type="checkbox" :checked="allowScale" @change="emit('update:allowScale', $event.target.checked)" />
      Also fit scale
    </label>
    <div class="tb-row">
      <button class="tb-textbtn" :disabled="!pairs.length" title="Remove the last click" @click="emit('undo')">Undo</button>
      <button class="tb-textbtn" :disabled="!pairs.length" @click="emit('clear')">Clear</button>
      <button class="tb-textbtn primary" :disabled="!fit || !!fit.error" @click="emit('apply', fit.transform)">Apply</button>
    </div>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.tb-field { grid-template-columns: 40px 1fr 0; }
.pairs {
  margin: 4px 0;
  padding: 0;
  list-style: none;
  max-height: 140px;
  overflow-y: auto;
  font-size: 11px;
}
.pairs li { display: flex; align-items: center; gap: 4px; padding: 1px 0; }
.res { margin-left: auto; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.source, strong.source { background: #ff8c1a; color: inherit; }
strong.source { background: none; color: #ff8c1a; }
strong.reference { color: #2f9bff; }
.dot.reference { background: #2f9bff; }
.dot.pending { opacity: 0.25; }
</style>
