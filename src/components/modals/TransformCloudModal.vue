<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import WarnBox from './ui/WarnBox.vue'
import { transformFromEuler, parseMatrixText, matrixFromTransform } from '../../core/products/cloudAlign.js'
import { cloudBounds } from '../../core/products/cloudEdit.js'

// Transform (Tools ▸ Point Cloud ▾) — move, rotate and scale a dense cloud, or apply
// a 4×4 matrix from another tool (core/products/cloudAlign.js). Adds a NEW cloud;
// positions stay Float64 so survey coordinates survive. Rotation is about fixed
// world axes, X then Y then Z, around the pivot (right-handed).
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

const sourceId = ref(props.clouds.some((c) => c.id === props.initialId) ? props.initialId : props.clouds[0]?.id ?? null)
const source = computed(() => props.clouds.find((c) => c.id === sourceId.value) ?? null)
const mode = ref('params')
const MODES = [{ id: 'params', label: 'Move / rotate / scale' }, { id: 'matrix', label: '4×4 matrix' }]
const p = ref({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, scale: 1, pivot: 'centre' })
const matrixText = ref('1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1')

const centre = computed(() => {
  const b = source.value ? cloudBounds(source.value) : null
  return b ? [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2] : [0, 0, 0]
})

// Parse/validate live, so a typo is explained before Run.
const parsed = computed(() => {
  try {
    if (mode.value === 'matrix') {
      const tf = parseMatrixText(matrixText.value)
      return { matrix: tf.matrix, note: tf.isSimilarity ? '' : 'Not a pure move/rotate/scale: shear or uneven scaling will be applied as given.' }
    }
    const v = p.value
    const tf = transformFromEuler({
      translate: [v.tx, v.ty, v.tz], rotateDeg: [v.rx, v.ry, v.rz], scale: v.scale,
      pivot: v.pivot === 'centre' ? centre.value : [0, 0, 0],
    })
    return { matrix: matrixFromTransform(tf), note: '' }
  } catch (err) {
    return { error: err.message }
  }
})

function run() {
  emit('run', {
    sourceIds: [sourceId.value],
    settings: { matrix: parsed.value.matrix },
    name: `${source.value?.name ?? 'Cloud'} (transformed)`,
  })
}
</script>

<template>
  <ModalShell title="Transform Cloud" @close="emit('close')">
    <WarnBox v-if="!clouds.length">No dense cloud yet. Build one with <strong>Dense Model</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Cloud" label-for="tf-src" hint="Adds a transformed copy; this one is left untouched.">
          <select id="tf-src" v-model="sourceId" class="field-select">
            <option v-for="c in clouds" :key="c.id" :value="c.id">{{ c.name }} — {{ c.count.toLocaleString() }} points</option>
          </select>
        </SettingsField>
        <SettingsField label="Define by">
          <SegmentedControl v-model="mode" :options="MODES" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup v-if="mode === 'params'" title="Transform">
        <SettingsField label="Move (X, Y, Z)" hint="In the cloud's own coordinates.">
          <div class="input-row">
            <input v-model.number="p.tx" type="number" step="any" class="field-input" aria-label="Move X" />
            <input v-model.number="p.ty" type="number" step="any" class="field-input" aria-label="Move Y" />
            <input v-model.number="p.tz" type="number" step="any" class="field-input" aria-label="Move Z" />
          </div>
        </SettingsField>
        <SettingsField label="Rotate (X, Y, Z)" unit="°" hint="About fixed world axes, X first, then Y, then Z.">
          <div class="input-row">
            <input v-model.number="p.rx" type="number" step="any" class="field-input" aria-label="Rotate X" />
            <input v-model.number="p.ry" type="number" step="any" class="field-input" aria-label="Rotate Y" />
            <input v-model.number="p.rz" type="number" step="any" class="field-input" aria-label="Rotate Z" />
          </div>
        </SettingsField>
        <SettingsField label="Scale" label-for="tf-scale" unit="×">
          <input id="tf-scale" v-model.number="p.scale" type="number" min="0.000001" step="any" class="field-input" />
        </SettingsField>
        <SettingsField label="Rotate and scale about" label-for="tf-pivot">
          <select id="tf-pivot" v-model="p.pivot" class="field-select">
            <option value="centre">The cloud's centre</option>
            <option value="origin">The coordinate origin</option>
          </select>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup v-else title="Matrix">
        <SettingsField label="Row-major 4×4 (or 3×4)" label-for="tf-matrix"
          hint="16 or 12 numbers, separated by spaces, commas or new lines — e.g. pasted from CloudCompare.">
          <textarea id="tf-matrix" v-model="matrixText" rows="4" class="field-input mono" spellcheck="false" />
        </SettingsField>
      </SettingsGroup>

      <WarnBox v-if="parsed.error">{{ parsed.error }}</WarnBox>
      <p v-else-if="parsed.note" class="field-hint">{{ parsed.note }}</p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !!parsed.error" @click="run">Transform</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.mono { font-family: ui-monospace, 'Cascadia Code', monospace; resize: vertical; }
</style>
