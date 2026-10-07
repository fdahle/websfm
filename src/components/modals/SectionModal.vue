<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { SECTION_DEFAULTS } from '../../core/defaults.user.js'
import { cloudBounds, estimateSpacing } from '../../core/products/cloudEdit.js'
import { cloudUnits } from '../../core/products/cloudUnits.js'

// Section (Tools ▸ Point Cloud ▾) — a vertical slice along a line A→B, `thickness`
// wide (core/products/cloudSection.js). Adds the slice as a NEW cloud and, if asked,
// downloads it as a 2D profile (station along A→B, height) for CAD/GIS.
// Coordinates are the cloud's own; heights are its Z.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
  frameSignature: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...SECTION_DEFAULTS, ax: 0, ay: 0, bx: 1, by: 0, format: 'csv' })
const sourceId = ref(props.clouds.some((c) => c.id === props.initialId) ? props.initialId : props.clouds[0]?.id ?? null)
const source = computed(() => props.clouds.find((c) => c.id === sourceId.value) ?? null)
const units = computed(() => cloudUnits(source.value, props.frameSignature))
// A typed coordinate/length is in the cloud's own frame: model units for a computed
// cloud even when the project has metres (those come from the frame's scale, shown
// alongside), the file's units for an imported one.
const unitLabel = computed(() => (source.value?.imported ? 'file units' : 'model units'))
const inMetres = (v) => (units.value.unit === 'm' ? ` ≈ ${(v * units.value.scale).toPrecision(3)} m` : '')
const spacing = ref(0)

// Default line: through the middle of the cloud along its longer horizontal axis.
function fillDefaultLine() {
  const c = source.value
  if (!c) return
  const b = cloudBounds(c)
  const r = (v) => Number(v.toFixed(3))
  const midX = (b.minX + b.maxX) / 2, midY = (b.minY + b.maxY) / 2
  const alongX = b.maxX - b.minX >= b.maxY - b.minY
  Object.assign(settings.value, alongX
    ? { ax: r(b.minX), ay: r(midY), bx: r(b.maxX), by: r(midY) }
    : { ax: r(midX), ay: r(b.minY), bx: r(midX), by: r(b.maxY) })
  spacing.value = estimateSpacing(b, c.count)
}
watch(source, fillDefaultLine, { immediate: true })

const thicknessAuto = computed(() => 3 * spacing.value)
const length = computed(() => Math.hypot(settings.value.bx - settings.value.ax, settings.value.by - settings.value.ay))

function run() {
  const s = settings.value
  const thickness = s.thickness > 0 ? s.thickness : thicknessAuto.value
  emit('run', {
    sourceIds: [sourceId.value],
    settings: { a: [s.ax, s.ay], b: [s.bx, s.by], thickness, extend: !!s.extend },
    name: `${source.value?.name ?? 'Cloud'} (section)`,
    download: s.format,
  })
}
</script>

<template>
  <ModalShell title="Cloud Section" @close="emit('close')">
    <WarnBox v-if="!clouds.length">No dense cloud yet. Build one with <strong>Dense Model</strong> or import one.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Cloud" label-for="sec-src">
          <select id="sec-src" v-model="sourceId" class="field-select">
            <option v-for="c in clouds" :key="c.id" :value="c.id">{{ c.name }} — {{ c.count.toLocaleString() }} points</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Section line">
        <SettingsField label="Start A (X, Y)">
          <div class="input-row">
            <input v-model.number="settings.ax" type="number" step="any" class="field-input" aria-label="A x" />
            <input v-model.number="settings.ay" type="number" step="any" class="field-input" aria-label="A y" />
          </div>
        </SettingsField>
        <SettingsField label="End B (X, Y)">
          <div class="input-row">
            <input v-model.number="settings.bx" type="number" step="any" class="field-input" aria-label="B x" />
            <input v-model.number="settings.by" type="number" step="any" class="field-input" aria-label="B y" />
          </div>
        </SettingsField>
        <SettingsField :hint="`Line length ${length.toPrecision(4)} ${unitLabel}${inMetres(length)}.`">
          <button type="button" class="btn" @click="fillDefaultLine">Across the middle</button>
        </SettingsField>
        <SettingsField label="Slice thickness" label-for="sec-thick" :unit="unitLabel"
          :hint="`0 = auto (${thicknessAuto.toPrecision(3)} ${unitLabel}${inMetres(thicknessAuto)}, about three point spacings).`">
          <input id="sec-thick" v-model.number="settings.thickness" type="number" min="0" step="any" class="field-input" />
        </SettingsField>
        <SettingsField hint="Also keep points beyond A and B along the same line.">
          <label class="checkbox-row"><input v-model="settings.extend" type="checkbox" class="checkbox" /> Extend past the ends</label>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Profile download">
        <SettingsField label="Format" label-for="sec-fmt" hint="Station (distance from A) and height, plus the original X/Y in CSV.">
          <select id="sec-fmt" v-model="settings.format" class="field-select">
            <option value="csv">CSV</option>
            <option value="dxf">DXF (points)</option>
            <option value="none">No download — just add the slice</option>
          </select>
        </SettingsField>
      </SettingsGroup>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || !(length > 0)" @click="run">Cut section</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
