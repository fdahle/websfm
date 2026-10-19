<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { useSensorsStore } from '../../stores/useSensorsStore.js'
import { RESEAU_DEFAULTS } from '../../core/defaults.user.js'
import { reseauLattice } from '../../core/sfm/reseauDetect.js'
import FieldHelp from '../guide/FieldHelp.vue'
import ModalShell from './ui/ModalShell.vue'
import { showToast } from '../../composables/useToasts.js'
import { pluralize } from '../../core/textFormat.js'

// Tools ▸ Images ▾ ▸ Detect reseau (SAT-5): find the reseau crosses in every scan of a
// sensor (useImagesStore.detectReseauForSensor) and apply the 'reseau' calibration, so
// reconstruction corrects each scan by its own crosses (core/sfm/ingest.js).
const emit = defineEmits(['close'])

const imagesStore = useImagesStore()
const sensorsStore = useSensorsStore()
const { sensors } = storeToRefs(sensorsStore)

// A reseau needs the scan pitch: the sensors that have one.
const candidates = computed(() => sensors.value.filter((s) => Number(s.pixelSize) > 0))
const sensorId = ref(candidates.value[0]?.id ?? null)
const sensor = computed(() => candidates.value.find((s) => s.id === sensorId.value) ?? null)
const sensorImages = computed(() => imagesStore.images.filter((img) => img.sensorId === sensorId.value))

const settings = reactive({ ...RESEAU_DEFAULTS, filmWidthMm: 0, filmHeightMm: 0 })
// Film size from the first scan × the pitch, whenever the sensor changes.
watch(sensor, (s) => {
  const img = sensorImages.value.find((i) => i.meta?.width > 0)
  const pitch = Number(s?.pixelSize) || 0
  settings.filmWidthMm = img ? Math.round(img.meta.width * pitch * 10) / 10 : 0
  settings.filmHeightMm = img ? Math.round(img.meta.height * pitch * 10) / 10 : 0
}, { immediate: true })
const filmSizeText = computed(() => `${settings.filmWidthMm} × ${settings.filmHeightMm} mm`)
const crossCount = computed(() => reseauLattice(settings).length)

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
    const { calibration, perImage, cancelled } = await imagesStore.detectReseauForSensor({
      sensor: sensor.value, settings: { ...settings },
      onProgress: (done, total, name) => { progress.value = { done, total, name } },
      shouldCancel: () => cancel,
    })
    results.value = perImage
    if (cancelled) return
    const usable = perImage.filter((r) => r.affineRmsUm != null).length
    if (usable && calibration) {
      sensorsStore.setFiducialCalibration(sensor.value.id, calibration)
      showToast('Reseau calibration applied', { detail: `${usable} of ${pluralize(perImage.length, 'scan')} — run Sparse Reconstruction again` })
    } else {
      showToast('No reseau found', { detail: 'Check the spacing, the scan pixel size and the cross size', kind: 'error', ms: 6000 })
    }
  } catch (err) {
    showToast('Reseau detection failed', { detail: err?.message ?? String(err), kind: 'error', ms: 6000 })
  } finally { busy.value = false }
}

const um = (v) => (v == null ? '—' : `${v.toFixed(1)} µm`)
</script>

<template>
  <ModalShell title="Detect Reseau" width="560px" @close="emit('close')">
    <p v-if="!candidates.length" class="empty">
      No sensor has a scan pixel size. Set the <b>px size</b> (mm per pixel) of the film sensor in the sensor table first.
    </p>
    <template v-else>
      <div class="grid">
        <label class="lbl" for="reseau-sensor"><FieldHelp op="reseau" param="sensor">Sensor</FieldHelp></label>
        <select id="reseau-sensor" v-model="sensorId" class="field-input field-select" :disabled="busy">
          <option v-for="s in candidates" :key="s.id" :value="s.id">{{ s.label }} — {{ s.pixelSize }} mm/px</option>
        </select>

        <label class="lbl" for="reseau-spacing"><FieldHelp op="reseau" param="spacingMm" :value="settings.spacingMm" :default-value="RESEAU_DEFAULTS.spacingMm">Cross spacing</FieldHelp></label>
        <span><input id="reseau-spacing" v-model.number="settings.spacingMm" class="field-input short" type="number" min="0.1" step="0.5" :disabled="busy" /> mm</span>

        <label class="lbl" for="reseau-film-w"><FieldHelp op="reseau" param="filmSize" :value="filmSizeText">Film size</FieldHelp></label>
        <span>
          <input id="reseau-film-w" v-model.number="settings.filmWidthMm" class="field-input short" type="number" min="1" step="1" :disabled="busy" aria-label="Film width" />
          ×
          <input v-model.number="settings.filmHeightMm" class="field-input short" type="number" min="1" step="1" :disabled="busy" aria-label="Film height" /> mm
        </span>

        <label class="lbl" for="reseau-arm"><FieldHelp op="reseau" param="armMm" :value="settings.armMm" :default-value="RESEAU_DEFAULTS.armMm">Cross arm</FieldHelp></label>
        <span><input id="reseau-arm" v-model.number="settings.armMm" class="field-input short" type="number" min="0.05" step="0.05" :disabled="busy" /> mm</span>

        <label class="lbl" for="reseau-width"><FieldHelp op="reseau" param="widthMm" :value="settings.widthMm" :default-value="RESEAU_DEFAULTS.widthMm">Line width</FieldHelp></label>
        <span><input id="reseau-width" v-model.number="settings.widthMm" class="field-input short" type="number" min="0.001" step="0.005" :disabled="busy" /> mm</span>
      </div>
      <p class="hint">{{ pluralize(crossCount, 'cross', 'crosses') }} per frame, searched on {{ pluralize(sensorImages.length, 'scan') }}.</p>

      <div v-if="busy" class="status" role="status">
        Scan {{ progress.done + 1 }} of {{ progress.total }}<span v-if="progress.name"> — {{ progress.name }}</span>
      </div>

      <table v-if="results?.length" class="results">
        <thead><tr><th>Scan</th><th>Crosses</th><th title="Film deformation beyond the scan's placement">Deformation</th><th title="Left after the correction (the crosses' measurement noise)">Left</th><th>Outliers</th></tr></thead>
        <tbody>
          <tr v-for="r in results" :key="r.id">
            <td>{{ r.name }}</td>
            <td v-if="r.error" colspan="4" class="err">{{ r.error }}</td>
            <template v-else>
              <td>{{ r.found }} / {{ r.of }}</td><td>{{ um(r.affineRmsUm) }}</td><td>{{ um(r.rmsUm) }}</td><td>{{ r.outliers ?? '—' }}</td>
            </template>
          </tr>
        </tbody>
      </table>
    </template>

    <template #footer>
      <button v-if="busy" class="btn" @click="cancel = true">Cancel</button>
      <button v-else class="btn" @click="emit('close')">Close</button>
      <button class="btn btn-primary" :disabled="busy || !sensor || !crossCount || !sensorImages.length" @click="run">Detect</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center; font-size: 12px; }
.lbl { color: var(--text); }
.short { width: 72px; }
.hint, .status, .empty { font-size: 12px; color: var(--text-dim); margin: 10px 0 0; }
.results { width: 100%; margin-top: 12px; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.results th, .results td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--panel-border); }
.results th { color: var(--text-dim); font-weight: 500; }
.err { color: var(--danger, #d9534f); }
</style>
