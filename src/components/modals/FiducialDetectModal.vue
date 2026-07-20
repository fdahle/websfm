<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import WarnBox from './ui/WarnBox.vue'
import { FIDUCIAL_SPOT_DEFAULTS } from '../../core/defaults.user.js'
import { useImagesStore } from '../../stores/useImagesStore.js'

const props = defineProps({
  sensor: { type: Object, required: true },
  images: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'open-image'])
const imagesStore = useImagesStore()
const settings = ref({ ...FIDUCIAL_SPOT_DEFAULTS })
const running = ref(false), error = ref(''), results = ref(null), drafts = ref([])
const masksGenerated = ref(0)
const progress = ref({ done: 0, total: 0 })
const existingCount = computed(() => props.images.reduce((n, i) => n + (i.fiducialDetections?.length ?? 0), 0))
const summary = computed(() => results.value ? {
  complete: results.value.filter((r) => r.accepted === r.requested && !r.drafts).length,
  accepted: results.value.reduce((n, r) => n + r.accepted, 0),
  draft: drafts.value.length,
} : null)

async function run() {
  if (running.value || !props.images.length) return
  running.value = true; error.value = ''; results.value = null; drafts.value = []; masksGenerated.value = 0
  progress.value = { done: 0, total: props.images.length }
  try {
    const out = await imagesStore.detectFiducialsForSensor({
      sensor: props.sensor,
      settings: settings.value,
      overwrite: settings.value.overwrite,
      onProgress: (done, total) => { progress.value = { done, total } },
    })
    results.value = out.perImage; drafts.value = out.drafts; masksGenerated.value = out.masksGenerated ?? 0
  } catch (err) { error.value = err.message }
  finally { running.value = false }
}

function acceptDraft(draft) {
  imagesStore.setFiducialDetection(draft.imageId, { ...draft, reviewed: true, source: `${draft.source || 'shape'}-review` })
  drafts.value = drafts.value.filter((d) => d !== draft)
}

function rejectDraft(draft) { drafts.value = drafts.value.filter((d) => d !== draft) }
</script>

<template>
  <ModalShell title="Detect Fiducials" @close="emit('close')">
    <WarnBox v-if="!images.length">No images are assigned to this film sensor.</WarnBox>

    <SettingsGroup title="Detection">
      <SettingsField label="Detection type" label-for="fidFamily"
        hint="Generic covers dots, rings and crosshairs; the other modes use their structural shape.">
        <select id="fidFamily" v-model="settings.family" class="field-select" :disabled="running">
          <option value="generic">Generic</option>
          <option value="right-angle">Right angle</option>
          <option value="cut-45">45° cut</option>
          <option value="frame">Frame</option>
        </select>
      </SettingsField>
      <SettingsField label="Fiducial positions" label-for="fidPositions"
        hint="Where marks are expected relative to the detected film frame.">
        <select id="fidPositions" v-model="settings.positions" class="field-select" :disabled="running">
          <option value="corners">Corners</option>
          <option value="sides">Sides</option>
          <option value="corners+sides">Corners and sides</option>
        </select>
      </SettingsField>
      <SettingsField label="Polarity" label-for="fidPolarity">
        <select id="fidPolarity" v-model="settings.polarity" class="field-select" :disabled="running">
          <option value="auto">Auto</option><option value="dark">Dark marks</option><option value="light">Light marks</option>
        </select>
      </SettingsField>
      <SettingsField label="Tolerance" label-for="fidTolerance"
        :hint="`${Math.round(settings.tolerance * 100)}% — higher values send weaker candidates to review.`">
        <input id="fidTolerance" v-model.number="settings.tolerance" type="range" min="0" max="1" step="0.05" :disabled="running" />
      </SettingsField>
      <p class="fid-hint">{{ images.length }} image{{ images.length === 1 ? '' : 's' }} will be searched. Calibration is not required.</p>
    </SettingsGroup>

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Output">
        <SettingsField hint="Existing accepted detections are preserved when disabled.">
          <template #label>Overwrite existing detections</template>
          <label class="checkbox-row"><input v-model="settings.overwrite" type="checkbox" class="checkbox" :disabled="running" /> Enabled</label>
        </SettingsField>
        <SettingsField hint="Uses the detected film frame to exclude scanner background, merging with an existing mask unless overwrite is enabled.">
          <template #label>Generate background masks</template>
          <label class="checkbox-row"><input v-model="settings.generateMasks" type="checkbox" class="checkbox" :disabled="running" /> Enabled</label>
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <div v-if="running" class="fid-progress">
      <div class="fid-bar"><div class="fid-fill" :style="{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }" /></div>
      <span class="fid-hint">Detecting {{ progress.done }} / {{ progress.total }}…</span>
    </div>
    <WarnBox v-if="error">{{ error }}</WarnBox>

    <SettingsGroup v-if="results" title="Results">
      <p class="fid-hint">{{ summary.accepted }} accepted spot{{ summary.accepted === 1 ? '' : 's' }}; {{ summary.draft }} need review. Existing before run: {{ existingCount }}.</p>
      <p v-if="masksGenerated" class="fid-hint">Generated {{ masksGenerated }} background mask{{ masksGenerated === 1 ? '' : 's' }} from confident film frames.</p>
      <table class="fid-results">
        <thead><tr><th>Image</th><th>Found</th><th>Drafts</th><th>Confidence</th><th>Frame</th></tr></thead>
        <tbody>
          <tr v-for="r in results" :key="r.id" class="fid-row" @click="emit('open-image', r.id)">
            <td class="fid-name">{{ r.name }}</td><td>{{ r.accepted }}/{{ r.requested }}</td><td>{{ r.drafts }}</td>
            <td>{{ (r.confidence * 100).toFixed(0) }}%</td><td>{{ (r.frameConfidence * 100).toFixed(0) }}%</td>
          </tr>
        </tbody>
      </table>
      <template v-if="drafts.length">
        <p class="fid-hint">Uncertain candidates are not stored until you accept them.</p>
        <table class="fid-results">
          <thead><tr><th>Image</th><th>Position</th><th>Reason</th><th>Confidence</th><th></th></tr></thead>
          <tbody>
            <tr v-for="d in drafts" :key="`${d.imageId}:${d.slot}`">
              <td class="fid-name"><button class="fid-link" @click="emit('open-image', d.imageId)">{{ d.imageName }}</button></td>
              <td>{{ d.slot }}</td><td>{{ d.reason }}</td><td>{{ (d.confidence * 100).toFixed(0) }}%</td>
              <td class="fid-actions"><button class="btn btn-sm" @click="acceptDraft(d)">Accept</button><button class="btn btn-sm" @click="rejectDraft(d)">Reject</button></td>
            </tr>
          </tbody>
        </table>
      </template>
    </SettingsGroup>

    <template #footer>
      <button class="btn" @click="emit('close')">{{ results ? 'Done' : 'Cancel' }}</button>
      <button class="btn btn-primary" :disabled="running || !images.length" @click="run">{{ running ? 'Detecting…' : 'Detect Fiducials' }}</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.fid-hint { color: var(--text-dim); font-size: 11px; margin: 4px 0 0; }
.fid-progress { margin: 10px 0; }.fid-bar { height: 6px; background: var(--bg); border: 1px solid var(--panel-border); border-radius: 3px; overflow: hidden; }
.fid-fill { height: 100%; background: var(--accent); transition: width .15s linear; }
.fid-results { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }.fid-results th,.fid-results td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--panel-border); }
.fid-row { cursor:pointer; }.fid-row:hover { background:var(--hover-bg); }.fid-name { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fid-link { color:var(--accent); background:none; border:0; padding:0; cursor:pointer; }.fid-actions { display:flex; gap:4px; }.btn-sm { padding:2px 6px; font-size:10px; }
</style>
