<script setup>
import { computed } from 'vue'
import FloatingToolbox from './FloatingToolbox.vue'

// The Region tool's toolbox (Tools ▸ Model ▾ ▸ Region): edits the DRAFT box the 3D
// view draws, until Apply stores it as the reconstruction region
// (core/products/region.js). Coordinates are the sparse model's own (model units).
// The box shapes the next depth-map / fusion / mesh / DEM run — nothing already
// computed is cut.
const props = defineProps({
  // { min:[x,y,z], max:[x,y,z] } — v-model.
  modelValue: { type: Object, required: true },
  // 'none' | 'active' | 'stale' — what is saved now.
  savedState: { type: String, default: 'none' },
  canFitDense: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'fit', 'apply', 'clear', 'close'])

const AXES = ['X', 'Y', 'Z']
function set(which, axis, value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return
  const next = { min: [...props.modelValue.min], max: [...props.modelValue.max] }
  next[which][axis] = v
  emit('update:modelValue', next)
}
const valid = computed(() => [0, 1, 2].every((a) => props.modelValue.max[a] > props.modelValue.min[a]))
const fmt = (v) => Number(v.toPrecision(6))
</script>

<template>
  <FloatingToolbox id="region" title="Region" :width="300" close-title="Close the region tool (Esc)" @close="emit('close')">
    <div class="tb-hint">
      Depth maps, fusion, mesh and DEM use only what lies inside the box.
      <template v-if="savedState === 'stale'"> The saved box was drawn on an older model and is ignored until reapplied.</template>
    </div>
    <div class="grid">
      <span></span><span class="head">min</span><span class="head">max</span>
      <template v-for="(a, i) in AXES" :key="a">
        <span class="axis">{{ a }}</span>
        <input class="tb-input" type="number" step="any" :value="fmt(modelValue.min[i])" :aria-label="`${a} min`"
          @change="set('min', i, $event.target.value)" />
        <input class="tb-input" type="number" step="any" :value="fmt(modelValue.max[i])" :aria-label="`${a} max`"
          @change="set('max', i, $event.target.value)" />
      </template>
    </div>
    <div class="tb-row">
      <button class="tb-textbtn" title="Around the sparse points (ignoring the farthest 2 %)" @click="emit('fit', 'sparse')">Fit to sparse</button>
      <button class="tb-textbtn" :disabled="!canFitDense" title="Around the dense cloud" @click="emit('fit', 'dense')">Fit to dense</button>
    </div>
    <div class="tb-row">
      <button class="tb-textbtn primary" :disabled="!valid" @click="emit('apply')">Apply</button>
      <button class="tb-textbtn danger" :disabled="savedState === 'none'" @click="emit('clear')">Remove region</button>
    </div>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.grid {
  display: grid;
  grid-template-columns: 16px 1fr 1fr;
  gap: 4px 6px;
  align-items: center;
  margin: 8px 0;
  font-size: 11px;
}
.head { color: var(--text-dim); text-align: center; }
.axis { color: var(--text-dim); font-weight: 600; }
</style>
