<script setup>
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { useSensorsStore } from '../../stores/useSensorsStore.js'
import { PANORAMIC_DEFAULTS } from '../../core/defaults.user.js'
import { panoramicSegments } from '../../core/sfm/panoramic.js'
import FieldHelp from '../guide/FieldHelp.vue'
import ModalShell from './ui/ModalShell.vue'
import { showToast } from '../../composables/useToasts.js'
import { pluralize } from '../../core/textFormat.js'

// Tools ▸ Images ▾ ▸ Split panoramic strips (plan-satellite ▸ group 2): every scan of a
// panoramic (optical-bar) sensor cut into segments, each an exact pinhole image of the
// film's cylinder (useImagesStore.splitPanoramicForSensor, core/sfm/panoramic.js), so
// reconstruction can treat them as frame cameras.
const emit = defineEmits(['close'])

const imagesStore = useImagesStore()
const sensorsStore = useSensorsStore()
const { sensors } = storeToRefs(sensorsStore)

const focalMmOf = (s) => (s.focalUnit === 'mm' && Number(s.focal) > 0 ? Number(s.focal) : (s.fiducialCalibration?.focalMm ?? 0))
// A split needs the scan pitch and the focal length in mm.
const candidates = computed(() => sensors.value.filter((s) => Number(s.pixelSize) > 0 && focalMmOf(s) > 0 && !s.panoramicSegments))
// The longest scans first: a panoramic sensor's strips are far longer than they are high.
const aspectOf = (s) => {
  const img = imagesStore.images.find((i) => i.sensorId === s.id && i.meta?.width > 0)
  return img ? Math.max(img.meta.width, img.meta.height) / Math.min(img.meta.width, img.meta.height) : 0
}
const sensorId = ref([...candidates.value].sort((a, b) => aspectOf(b) - aspectOf(a))[0]?.id ?? null)
const sensor = computed(() => candidates.value.find((s) => s.id === sensorId.value) ?? null)
const strips = computed(() => imagesStore.images.filter((img) => img.sensorId === sensorId.value))

const settings = reactive({ ...PANORAMIC_DEFAULTS })

// What the first strip becomes, for the line under the fields.
const preview = computed(() => {
  const s = sensor.value, img = strips.value.find((i) => i.meta?.width > 0)
  if (!s || !img) return null
  try {
    const layout = panoramicSegments({ width: img.meta.width, height: img.meta.height, pitchMm: Number(s.pixelSize), focalMm: focalMmOf(s) },
      { segments: settings.segments, overlap: settings.overlapPct / 100 })
    const seg = layout.segments[0]
    return { n: layout.segments.length, w: seg.width, h: seg.height, scanDeg: layout.scanRad * 180 / Math.PI,
      segDeg: 2 * seg.halfRad * 180 / Math.PI, aspect: layout.length / layout.across }
  } catch { return null }
})

const busy = ref(false)
const progress = ref({ done: 0, total: 0, name: '' })
const results = ref(null)
let cancel = false

async function run() {
  if (!sensor.value || busy.value) return
  busy.value = true
  cancel = false
  results.value = null
  try {
    const { strips: rows, images } = await imagesStore.splitPanoramicForSensor({
      sensor: sensor.value, settings: { segments: settings.segments, overlapPct: settings.overlapPct },
      removeStrips: settings.removeStrips,
      onProgress: (done, total, name) => { progress.value = { done: Math.floor(done), total, name } },
      shouldCancel: () => cancel,
    })
    results.value = rows
    if (images.length) {
      showToast(`Split into ${pluralize(images.length, 'segment')}`, { detail: 'Detect features and reconstruct the segments' })
    } else {
      showToast('No strip split', { detail: rows[0]?.error ?? 'See the log', kind: 'error', ms: 6000 })
    }
  } catch (err) {
    showToast('Split failed', { detail: err?.message ?? String(err), kind: 'error', ms: 6000 })
  } finally { busy.value = false }
}
</script>

<template>
  <ModalShell title="Split Panoramic Strips" width="540px" @close="emit('close')">
    <p v-if="!candidates.length" class="empty">
      No sensor has both a scan pixel size and a focal length in mm. Set them for the panoramic camera in the sensor table first.
    </p>
    <template v-else>
      <div class="grid">
        <label class="lbl" for="pan-sensor"><FieldHelp op="panoramic" param="sensor">Sensor</FieldHelp></label>
        <select id="pan-sensor" v-model="sensorId" class="field-input field-select" :disabled="busy">
          <option v-for="s in candidates" :key="s.id" :value="s.id">{{ s.label }} — f {{ focalMmOf(s) }} mm, {{ s.pixelSize }} mm/px</option>
        </select>

        <label class="lbl" for="pan-segments"><FieldHelp op="panoramic" param="segments" :value="settings.segments || 'Auto'" :default-value="PANORAMIC_DEFAULTS.segments || 'Auto'">Segments per strip</FieldHelp></label>
        <span><input id="pan-segments" v-model.number="settings.segments" class="field-input short" type="number" min="0" step="1" :disabled="busy" /> <span class="unit">0 = Auto</span></span>

        <label class="lbl" for="pan-overlap"><FieldHelp op="panoramic" param="overlapPct" :value="settings.overlapPct" :default-value="PANORAMIC_DEFAULTS.overlapPct">Overlap</FieldHelp></label>
        <span><input id="pan-overlap" v-model.number="settings.overlapPct" class="field-input short" type="number" min="0" max="50" step="5" :disabled="busy" /> %</span>
      </div>
      <p v-if="preview" class="hint">
        {{ pluralize(strips.length, 'strip') }} of {{ preview.scanDeg.toFixed(0) }}° scan each →
        {{ pluralize(preview.n, 'segment') }} of {{ preview.w.toLocaleString() }} × {{ preview.h.toLocaleString() }} px
        ({{ preview.segDeg.toFixed(1) }}° each).
        <template v-if="preview.aspect < 3"> These scans are not much longer than high: are they panoramic?</template>
      </p>
      <label class="opt"><input v-model="settings.removeStrips" type="checkbox" :disabled="busy" /> <FieldHelp op="panoramic" param="removeStrips" :value="settings.removeStrips" :default-value="PANORAMIC_DEFAULTS.removeStrips">Remove the strips after splitting</FieldHelp></label>

      <div v-if="busy" class="status" role="status">
        Strip {{ Math.min(progress.total, progress.done + 1) }} of {{ progress.total }}<span v-if="progress.name"> — {{ progress.name }}</span>
      </div>

      <table v-if="results?.length" class="results">
        <thead><tr><th>Strip</th><th>Scan</th><th>Segments</th><th>GCP marks</th></tr></thead>
        <tbody>
          <tr v-for="r in results" :key="r.name">
            <td>{{ r.name }}</td>
            <td v-if="r.error" colspan="3" class="err">{{ r.error }}</td>
            <template v-else>
              <td>{{ r.scanDeg.toFixed(1) }}°</td><td>{{ r.segments }} of {{ r.size[0] }} × {{ r.size[1] }}</td><td>{{ r.marks }}</td>
            </template>
          </tr>
        </tbody>
      </table>
    </template>

    <template #footer>
      <button v-if="busy" class="btn" @click="cancel = true">Cancel</button>
      <button v-else class="btn" @click="emit('close')">Close</button>
      <button class="btn btn-primary" :disabled="busy || !sensor || !strips.length" @click="run">Split</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center; font-size: 12px; }
.lbl { color: var(--text); }
.short { width: 72px; }
.unit { color: var(--text-dim); }
.opt { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; margin-top: 8px; }
.hint, .status, .empty { font-size: 12px; color: var(--text-dim); margin: 10px 0 0; }
.results { width: 100%; margin-top: 12px; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.results th, .results td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--panel-border); }
.results th { color: var(--text-dim); font-weight: 500; }
.err { color: var(--danger, #d9534f); }
</style>
