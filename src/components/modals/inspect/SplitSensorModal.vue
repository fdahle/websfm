<script setup>
// Sidebar ▸ Sensors ▸ Split camera group…: split one sensor into several, by the
// suggestion (core/sensors/splitSuggestions.js), by scan format or by roll. The groups
// are only proposed here; Split applies them (useSensorsStore.splitSensor).
import { computed, ref } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { splitBy } from '../../../core/sensors/splitSuggestions.js'
import { SENSOR_TUNING } from '../../../core/tuning.js'
import { pluralize } from '../../../core/textFormat.js'

const props = defineProps({
  sensor: { type: Object, required: true },
  // [{ id, name, sensorId, meta, fiducialDetections }]
  images: { type: Array, default: () => [] },
  // This sensor's entry of suggestSensorSplits, or null.
  suggestion: { type: Object, default: null },
})
const emit = defineEmits(['close', 'split'])

const film = computed(() => props.sensor.kind === 'film')
// A film camera's image size is its scan format.
const sizeWord = computed(() => (film.value ? 'scan format' : 'image size'))
const by = ref(props.suggestion ? 'suggested' : 'format')
const options = computed(() => [
  { id: 'suggested', label: 'Suggested', disabled: !props.suggestion },
  { id: 'format', label: film.value ? 'Scan format' : 'Image size' },
  { id: 'roll', label: 'Roll' },
])
const groups = computed(() =>
  by.value === 'suggested' ? (props.suggestion?.groups ?? []) : splitBy(props.sensor, props.images, by.value),
)
const nameOf = computed(() => new Map(props.images.map((im) => [im.id, im.name])))
// A few photo names of a group, for the table.
function examples(ids) {
  const names = ids.slice(0, 3).map((id) => nameOf.value.get(id))
  return ids.length > 3 ? `${names.join(', ')} …` : names.join(', ')
}
const um = (v) => `${Math.round(v)} µm`
</script>

<template>
  <ModalShell title="Split Camera Group" width="min(94vw, 680px)" @close="emit('close')">
    <p class="intro">
      The photos of <strong>{{ sensor.label }}</strong> share one focal length, principal point{{
        film ? ', lens distortion and fiducial layout' : ' and lens distortion'
      }}. Photos of another camera in it bend the model; a group of each camera keeps it true.
    </p>

    <ul v-if="suggestion" class="evidence">
      <li v-if="suggestion.formats.length">
        {{ film ? 'Scan formats' : 'Image sizes' }}:
        {{ suggestion.formats.map((f) => `${f.key} (${pluralize(f.images, 'photo')})`).join(', ') }}.
      </li>
      <li v-for="m in suggestion.misfits" :key="m.roll">
        {{ m.roll }}: {{ pluralize(m.images, 'photo') }} fit the fiducial layout at {{ um(m.medianUm) }}, the others at
        {{ um(m.othersUm) }}.
      </li>
    </ul>
    <p v-else class="hint">Nothing here suggests another camera; you can still split by {{ sizeWord }} or roll.</p>

    <div class="row">
      <span class="lbl"><FieldHelp op="camera-groups" param="splitBy">Split by</FieldHelp></span>
      <SegmentedControl v-model="by" :options="options" />
    </div>

    <table class="groups">
      <thead>
        <tr>
          <th>Group</th>
          <th>Photos</th>
          <th>For example</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in groups" :key="g.label">
          <td>{{ g.label }}</td>
          <td :class="{ small: g.small }" :title="g.small ? 'Fewer self-calibration terms' : ''">
            {{ g.imageIds.length }}
          </td>
          <td class="names">{{ examples(g.imageIds) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="groups.length < 2" class="hint">This keeps every photo in one group: there is nothing to split.</p>
    <p v-else-if="groups.some((g) => g.small)" class="hint">
      A group of fewer than {{ SENSOR_TUNING.splitMinImages }} photos gets fewer self-calibration terms: the principal
      point stays where it is.
    </p>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="groups.length < 2"
        :title="groups.length < 2 ? 'This split gives only one group: choose another way to split' : null"
        @click="emit('split', groups)"
      >
        Split into {{ groups.length }} groups
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.evidence {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.6;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}
.hint {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0;
}
.groups {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.groups th,
.groups td {
  text-align: left;
  padding: 3px 6px;
  border-bottom: 1px solid var(--panel-border);
}
.groups th {
  color: var(--text-dim);
  font-weight: 500;
}
.small {
  color: var(--warn, #d9a441);
}
.names {
  color: var(--text-dim);
}
</style>
