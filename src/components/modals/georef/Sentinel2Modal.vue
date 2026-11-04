<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import WarnBox from '../ui/WarnBox.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import DataTable from '../ui/DataTable.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { useLog } from '../../../composables/useLog.js'
import {
  sentinel2Area,
  searchSentinel2,
  fetchSentinel2Scene,
  sentinel2Outline,
} from '../../../composables/useSentinel2.js'
import { SENTINEL2_DEFAULTS } from '../../../core/defaults.user.js'
import { checkNumberFields } from '../../../utils/numberFields.js'

// Find GCPs ▸ Sentinel-2…: list the Sentinel-2 L2A scenes over the search area (the
// Earth Search catalogue), and fetch the chosen one's window as a reference
// orthophoto (composables/useSentinel2.js). A workbench: a search and a result table.
const props = defineProps({ searchSetId: { type: String, default: '' } })
const emit = defineEmits(['close', 'fetched'])
const { log } = useLog()

const settings = ref({
  maxCloud: SENTINEL2_DEFAULTS.maxCloud,
  from: SENTINEL2_DEFAULTS.from,
  to: SENTINEL2_DEFAULTS.to,
})
const area = ref(null),
  areaReady = ref(false),
  scenes = ref(null),
  chosenId = ref(''),
  busy = ref(''),
  error = ref('')
onMounted(async () => {
  try {
    area.value = await sentinel2Area(props.searchSetId || null)
  } catch (err) {
    error.value = err.message
  }
  areaReady.value = true
})

// The area's size on the ground, for the line under it.
const areaSize = computed(() => {
  const b = area.value?.bbox
  if (!b) return ''
  const km = (v) => (v < 10 ? v.toFixed(1) : v.toFixed(0))
  const w = (b[2] - b[0]) * 111.32 * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180),
    h = (b[3] - b[1]) * 110.57
  return `${km(w)} × ${km(h)} km`
})
const numbers = computed(() =>
  checkNumberFields({ maxCloud: settings.value.maxCloud }, { maxCloud: { label: 'Max cloud', min: 0, max: 100 } }),
)
const chosen = computed(() => scenes.value?.find((s) => s.id === chosenId.value) ?? null)

// The chosen scene's thumbnail (the whole tile), with the window a fetch reads
// outlined on it: cloud or an empty half over the area shows before the fetch.
const outline = ref(null),
  thumbFailed = ref(false)
watch(chosen, async (scene) => {
  outline.value = null
  thumbFailed.value = false
  if (!scene || !area.value) return
  const box = await sentinel2Outline(scene, area.value)
  if (chosen.value === scene) outline.value = box
})
const outlineStyle = computed(() => {
  const o = outline.value
  if (!o) return null
  const pc = (v) => `${(100 * v).toFixed(2)}%`
  return { left: pc(o.left), top: pc(o.top), width: pc(o.width), height: pc(o.height) }
})

async function search() {
  busy.value = 'search'
  error.value = ''
  try {
    scenes.value = await searchSentinel2(area.value, settings.value)
    chosenId.value = scenes.value[0]?.id ?? ''
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = ''
  }
}
async function fetchScene() {
  busy.value = 'fetch'
  error.value = ''
  try {
    const meta = await fetchSentinel2Scene(chosen.value, area.value, { onLog: log })
    emit('fetched', meta)
  } catch (err) {
    error.value = err.message
    busy.value = ''
  }
}

const pct = (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : v.toFixed(0)} %`)
const COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'tile', label: 'Tile' },
  { key: 'cloud', label: 'Cloud', align: 'right', format: pct },
  { key: 'snow', label: 'Snow & ice', align: 'right', format: pct },
  { key: 'coverage', label: 'Covers area', align: 'right', format: (v) => pct(v == null ? null : 100 * v) },
]
const rowClass = (row) => ({ 's2-chosen': row.id === chosenId.value })
</script>

<template>
  <ModalShell title="Sentinel-2 Reference" width="820px" @close="emit('close')">
    <p class="s2-intro">
      Fetch a Sentinel-2 image of the search area as a reference orthophoto: 10 m true colour from the Copernicus
      programme, free and open, read straight from AWS Open Data.
    </p>
    <WarnBox v-if="areaReady && !area"
      >Nothing says where the photos are. Choose a Search area in Find GCPs, or compute the photos' footprints
      first.</WarnBox
    >
    <SettingsGroup v-else title="Area">
      <p class="s2-line">
        <template v-if="area">Around {{ area.source }}: {{ areaSize }}, with a margin of a quarter.</template>
        <template v-else>Finding the search area…</template>
      </p>
    </SettingsGroup>

    <SettingsGroup title="Scenes">
      <div class="s2-row">
        <SettingsField label-for="s2-cloud" unit="%">
          <template #label
            ><FieldHelp
              op="georeferencing"
              param="sentinel2Cloud"
              :value="settings.maxCloud"
              :default-value="SENTINEL2_DEFAULTS.maxCloud"
              >Max cloud</FieldHelp
            ></template
          >
          <input
            id="s2-cloud"
            v-model.number="settings.maxCloud"
            :aria-invalid="numbers.bad.maxCloud"
            class="field-input"
            type="number"
            min="0"
            max="100"
            step="5"
          />
        </SettingsField>
        <SettingsField label="From" label-for="s2-from">
          <input id="s2-from" v-model="settings.from" class="field-input" type="date" />
        </SettingsField>
        <SettingsField label="To" label-for="s2-to">
          <input id="s2-to" v-model="settings.to" class="field-input" type="date" />
        </SettingsField>
      </div>
      <p v-if="busy === 'search'" class="s2-line" role="status">Asking the catalogue…</p>
      <template v-else-if="scenes">
        <p class="s2-line">
          {{
            scenes.length
              ? `${scenes.length} scenes, best first: covering the whole area, then the least cloud. Click one to choose it.`
              : 'No scene matches. Allow more cloud or a wider date range.'
          }}
        </p>
        <div v-if="scenes.length" class="s2-results">
          <DataTable
            class="s2-table"
            :columns="COLUMNS"
            :rows="scenes"
            :row-class="rowClass"
            @row-click="(row) => (chosenId = row.id)"
          />
          <figure v-if="chosen" class="s2-preview">
            <div class="s2-thumb">
              <!-- crossorigin: the app is cross-origin isolated (COEP), and the catalogue's
                   bucket answers CORS. -->
              <img
                v-if="chosen.thumbnail && !thumbFailed"
                :key="chosen.id"
                :src="chosen.thumbnail"
                crossorigin="anonymous"
                :alt="`Sentinel-2 tile ${chosen.tile} on ${chosen.date}`"
                @error="thumbFailed = true"
              />
              <span v-else class="s2-thumb-none">No preview</span>
              <span v-if="outlineStyle" class="s2-outline" :style="outlineStyle"></span>
            </div>
            <figcaption>Tile {{ chosen.tile }}, {{ chosen.date }}. The box is what will be read.</figcaption>
          </figure>
        </div>
        <WarnBox v-if="chosen && chosen.coverage != null && chosen.coverage < 0.99"
          >This scene covers {{ pct(100 * chosen.coverage) }} of the area: the rest of the window will be
          empty.</WarnBox
        >
      </template>
    </SettingsGroup>
    <p v-if="busy === 'fetch'" class="s2-line" role="status">
      Reading the red, green and blue bands of {{ chosen?.date }} over the area…
    </p>
    <p v-if="error" class="s2-error" role="alert">{{ error }}</p>
    <p class="field-hint">
      The image is stretched from its own reflectances, so snow and ice keep their texture, and its σ XY is set to
      {{ SENTINEL2_DEFAULTS.horizontalAccuracy }} m. Contains modified Copernicus Sentinel data.
    </p>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn"
        :class="{ 'btn-primary': !scenes?.length }"
        :disabled="!area || !!busy || !numbers.valid"
        :title="numbers.reason"
        @click="search"
      >
        {{ scenes ? 'Search again' : 'Search scenes' }}
      </button>
      <button
        v-if="scenes?.length"
        class="btn btn-primary"
        :disabled="!chosen || !!busy"
        :title="
          busy ? 'Wait for the search or download to finish' : !chosen ? 'Choose a scene in the list first' : null
        "
        @click="fetchScene"
      >
        Fetch {{ chosen?.date ?? '' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.s2-intro,
.s2-line {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-dim);
}
.s2-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.s2-row .field-input {
  width: 140px;
}
.s2-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
.s2-results {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
}
.s2-results .s2-table {
  flex: 1 1 380px;
  min-width: 0;
}
.s2-preview {
  flex: 0 0 220px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.s2-thumb {
  position: relative;
  width: 220px;
  height: 220px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg);
}
.s2-thumb img {
  display: block;
  width: 100%;
  height: 100%;
}
.s2-thumb-none {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--text-dim);
}
/* Two strokes, so the box reads on snow and on dark water alike. */
.s2-outline {
  position: absolute;
  border: 2px solid var(--accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
  min-width: 6px;
  min-height: 6px;
  pointer-events: none;
}
.s2-preview figcaption {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-dim);
}
.s2-table {
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
}
.s2-table :deep(.dt-row) {
  cursor: pointer;
}
.s2-table :deep(.dt-row.s2-chosen) {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
</style>
