<script setup>
import FloatingToolbox from './FloatingToolbox.vue'

// The Orient model tool's toolbox (Tools ▸ Model ▾): which way is up, where the
// origin is, which way X points — for products and exports of a project with no
// georeference (core/products/orientation.js). The coordinates themselves never
// change; this defines the frame they are expressed in. Picking happens in the 3D
// view (Viewer3D pickMode); this toolbox holds the draft.
defineProps({
  // { up:[x,y,z], origin:[x,y,z], headingDeg }
  draft: { type: Object, required: true },
  // null | 'plane' | 'origin' — what the next click in the 3D view sets.
  picking: { type: String, default: null },
  planePicks: { type: Number, default: 0 },
  savedState: { type: String, default: 'none' }, // 'none' | 'active' | 'stale'
  georeferenced: { type: Boolean, default: false },
})
const emit = defineEmits(['pick', 'auto-up', 'centre-origin', 'heading', 'apply', 'clear', 'close'])
const fmt = (v) => v.map((x) => x.toFixed(3)).join(', ')
</script>

<template>
  <FloatingToolbox id="orient" title="Orient model" :width="290" close-title="Close the orient tool (Esc)" @close="emit('close')">
    <div v-if="georeferenced" class="tb-hint warn">The project is georeferenced: its products use the CRS, and this orientation only applies to local-frame output.</div>
    <div v-if="savedState === 'stale'" class="tb-hint">The saved orientation was set on an older model and is ignored until reapplied.</div>

    <div class="tb-line"><strong>Up</strong> <span class="vec">{{ fmt(draft.up) }}</span></div>
    <div class="tb-row">
      <button class="tb-textbtn" :class="{ primary: picking === 'plane' }" @click="emit('pick', 'plane')">
        {{ picking === 'plane' ? `Click ground point ${planePicks + 1} of 3…` : 'Pick 3 ground points' }}
      </button>
      <button class="tb-textbtn" title="Estimate up from the camera viewing directions (the default)" @click="emit('auto-up')">From cameras</button>
    </div>

    <div class="tb-sep" />
    <div class="tb-line"><strong>Origin</strong> <span class="vec">{{ fmt(draft.origin) }}</span></div>
    <div class="tb-row">
      <button class="tb-textbtn" :class="{ primary: picking === 'origin' }" @click="emit('pick', 'origin')">
        {{ picking === 'origin' ? 'Click the origin point…' : 'Pick origin' }}
      </button>
      <button class="tb-textbtn" @click="emit('centre-origin')">Model centre</button>
    </div>

    <div class="tb-sep" />
    <label class="tb-field">
      <span>X heading</span>
      <input class="tb-input" type="number" step="1" :value="draft.headingDeg" aria-label="Heading in degrees"
        @change="emit('heading', Number($event.target.value))" />
      <span class="tb-val">°</span>
    </label>
    <div class="tb-hint">Turns X (and Y) about up, counter-clockwise.</div>

    <div class="tb-row">
      <button class="tb-textbtn primary" @click="emit('apply')">Apply</button>
      <button class="tb-textbtn danger" :disabled="savedState === 'none'" @click="emit('clear')">Remove orientation</button>
    </div>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.vec { color: var(--text-dim); font-variant-numeric: tabular-nums; font-size: 11px; margin-left: 4px; }
.warn { color: #d4900a; margin-bottom: 6px; }
</style>
