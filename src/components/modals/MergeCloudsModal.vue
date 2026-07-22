<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { MERGE_CLOUDS_DEFAULTS } from '../../core/defaults.user.js'

// Merge Clouds — concatenate two or more dense clouds into a new one. Coordinates
// are taken verbatim: merge assumes the inputs already share a frame, exactly as
// cloud import does. There is no CRS reprojection here.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  mergeCell: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...MERGE_CLOUDS_DEFAULTS })
const selected = ref(props.clouds.slice(0, 2).map((c) => c.id))

function toggle(id) {
  // Preserve list order in the selection — merge concatenates in the order given,
  // and the sidebar order is the order the user reasons about.
  const on = selected.value.includes(id)
  selected.value = props.clouds
    .filter((c) => (c.id === id ? !on : selected.value.includes(c.id)))
    .map((c) => c.id)
}

const chosen = computed(() => props.clouds.filter((c) => selected.value.includes(c.id)))
const total = computed(() => chosen.value.reduce((s, c) => s + (c.count || 0), 0))
// Normals survive only if every input has them (a partial normal field would
// mislead Poisson, which reads normals as oriented evidence).
const losesNormals = computed(
  () => chosen.value.some((c) => c.nrm) && !chosen.value.every((c) => c.nrm),
)

function run() {
  emit('run', {
    sourceIds: [...selected.value],
    settings: { cell: settings.value.cell },
    name: `Merged (${chosen.value.length} clouds)`,
  })
}
</script>

<template>
  <ModalShell title="Merge Clouds" @close="emit('close')">
    <WarnBox v-if="clouds.length < 2">
      Merging needs at least two dense clouds. Densify or import another cloud first —
      sparse clouds are not merged here, since their per-point view-tracks belong to one
      reconstruction.
    </WarnBox>

    <template v-else>
      <SettingsGroup title="Clouds">
        <SettingsField hint="Merged in this order. Coordinates are taken as-is — the clouds must already share a frame.">
          <label v-for="c in clouds" :key="c.id" class="checkbox-row">
            <input
              type="checkbox" class="checkbox"
              :checked="selected.includes(c.id)"
              @change="toggle(c.id)"
            />
            {{ c.name }} — {{ (c.count || 0).toLocaleString() }} points
          </label>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Overlap">
        <SettingsField label="Dedupe cell" label-for="merge-cell" unit="units"
          :hint="mergeCell > 0
            ? `Collapse the double-density seam to one point per cell. 0 = plain concatenation; the dense run used ${mergeCell.toPrecision(3)}.`
            : 'Collapse the double-density seam to one point per cell. 0 = plain concatenation.'">
          <input id="merge-cell" v-model.number="settings.cell" type="number" min="0" step="any" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <WarnBox v-if="losesNormals">
        Some of the selected clouds have per-point normals and some do not, so the merged
        cloud will have none — meaning it cannot be meshed until you re-run Densify.
      </WarnBox>

      <p class="field-hint">
        {{ chosen.length }} selected · {{ total.toLocaleString() }} points before dedupe.
      </p>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="selected.length < 2" @click="run">Merge</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
