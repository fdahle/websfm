<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import ChoiceCards from './ui/ChoiceCards.vue'
import DataTable from './ui/DataTable.vue'
import StatTiles from './ui/StatTiles.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import FiducialFamilyGlyph from './fiducial/FiducialFamilyGlyph.vue'
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

// Detection type: cards rather than a <select>, because the choice is a shape the
// user recognises in their own scans. Each card's picture is drawn from the same
// template math the detector correlates against (see FiducialFamilyGlyph).
const FAMILIES = [
  { id: 'generic', label: 'Generic', blurb: 'Dot, cross or ring' },
  { id: 'right-angle', label: 'Right angle', blurb: 'L-shaped corner' },
  { id: 'cut-45', label: '45° cut', blurb: 'Diagonal notch' },
  { id: 'frame', label: 'Frame', blurb: 'Film edge corner' },
]
// Long prose lives here, one selection at a time, instead of overflowing the card.
const FAMILY_HINTS = {
  generic: 'Sweeps dot, crosshair and ring templates at several sizes — the safest choice, and the one to start with when you are unsure what the marks look like.',
  'right-angle': 'Two strokes meeting at a right angle, as on corner-notch cameras. All four orientations are tried.',
  'cut-45': 'A 45° diagonal across the corner with a small offset dot.',
  frame: 'No mark template at all — the corner of the detected film frame is measured directly. For scans whose marks are missing, cropped or unreadable.',
}
const familyHint = computed(() => FAMILY_HINTS[settings.value.family] ?? '')

const POSITION_OPTIONS = [
  { id: 'corners', label: 'Corners' },
  { id: 'sides', label: 'Sides' },
  { id: 'corners+sides', label: 'Corners and sides' },
]
const POLARITY_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'dark', label: 'Dark marks' },
  { id: 'light', label: 'Light marks' },
]

const existingCount = computed(() =>
  props.images.reduce((n, i) => n + (i.fiducialDetections?.length ?? 0), 0))

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const SLOT_LABELS = {
  'corner-tl': 'Top-left corner', 'corner-tr': 'Top-right corner',
  'corner-br': 'Bottom-right corner', 'corner-bl': 'Bottom-left corner',
  'side-top': 'Top edge', 'side-right': 'Right edge',
  'side-bottom': 'Bottom edge', 'side-left': 'Left edge',
}
const REASON_LABELS = {
  'missing-slot': 'Nothing found here',
  'weak-peak': 'Match too weak',
  'two-peaks': 'Two similar candidates',
  'frame-uncertain': 'Film frame uncertain',
  'batch-outlier': 'Disagrees with the batch',
  'shape-inconsistent': 'Breaks the layout symmetry',
}

const summary = computed(() => results.value ? {
  complete: results.value.filter((r) => r.accepted === r.requested && !r.drafts).length,
  accepted: results.value.reduce((n, r) => n + r.accepted, 0),
  draft: drafts.value.length,
} : null)

const summaryTiles = computed(() => summary.value ? [
  { label: 'Marks accepted', value: summary.value.accepted, hint: `${existingCount.value} existed before this run` },
  {
    label: 'Images complete', value: `${summary.value.complete}/${results.value.length}`,
    tone: summary.value.complete === results.value.length ? 'ok' : 'warn',
  },
  {
    label: 'Need review', value: summary.value.draft,
    tone: summary.value.draft ? 'warn' : 'ok',
    hint: summary.value.draft ? 'Not stored until accepted' : undefined,
  },
  ...(masksGenerated.value ? [{ label: 'Masks generated', value: masksGenerated.value }] : []),
] : [])

const RESULT_COLUMNS = [
  { key: 'name', label: 'Image' },
  // Sorts on the completeness fraction (added in `resultRows`), reads as "3/4".
  { key: 'found', label: 'Found', align: 'right', format: (_v, r) => `${r.accepted}/${r.requested}` },
  { key: 'drafts', label: 'Review', align: 'right' },
  { key: 'confidence', label: 'Confidence', align: 'right', format: pct },
  { key: 'frameConfidence', label: 'Frame', align: 'right', format: pct },
]
const DRAFT_COLUMNS = [
  { key: 'imageName', label: 'Image' },
  { key: 'slot', label: 'Position', format: (v) => SLOT_LABELS[v] ?? v },
  { key: 'reason', label: 'Reason', format: (v) => REASON_LABELS[v] ?? v },
  { key: 'confidence', label: 'Confidence', align: 'right', format: pct },
  { key: 'actions', label: '', align: 'right', sortable: false },
]
const resultRows = computed(() => (results.value ?? []).map((r) => ({
  ...r, found: r.requested ? r.accepted / r.requested : null,
})))

// DataTable needs a stable row id, and the accept/reject actions need the original
// draft object back — so carry it on the row rather than reconstructing it.
const draftRows = computed(() => drafts.value.map((d) => ({
  id: `${d.imageId}:${d.slot}`,
  imageId: d.imageId, imageName: d.imageName, slot: d.slot,
  reason: d.reason, confidence: d.confidence, draft: d,
})))

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

// A missing-slot draft's position is only where the slot was expected — nothing
// was measured there, so accepting it would hand calibration and SfM a guess
// dressed as a mark. Place it by hand instead (image view ▸ right-click).
const canAccept = (draft) => draft.reason !== 'missing-slot'

function acceptDraft(draft) {
  if (!canAccept(draft)) return
  imagesStore.setFiducialDetection(draft.imageId, { ...draft, reviewed: true, source: `${draft.source || 'shape'}-review` })
  drafts.value = drafts.value.filter((d) => d !== draft)
}

function rejectDraft(draft) { drafts.value = drafts.value.filter((d) => d !== draft) }
</script>

<template>
  <ModalShell title="Detect Fiducials" @close="emit('close')">
    <WarnBox v-if="!images.length">No images are assigned to this film sensor.</WarnBox>

    <SettingsField :hint="familyHint">
      <template #label>
        <GlossaryTerm id="fiducial-marks">Detection type</GlossaryTerm>
      </template>
      <ChoiceCards v-model="settings.family" :options="FAMILIES">
        <template #visual="{ option }"><FiducialFamilyGlyph :family="option.id" /></template>
      </ChoiceCards>
    </SettingsField>

    <SettingsGroup title="Search">
      <SettingsField label="Fiducial positions"
        hint="Where marks are expected relative to the detected film frame.">
        <SegmentedControl v-model="settings.positions" :options="POSITION_OPTIONS" />
      </SettingsField>
      <SettingsField label="Tolerance" label-for="fidTolerance"
        :hint="`${Math.round(settings.tolerance * 100)}% — higher values send weaker candidates to review instead of dropping them.`">
        <input
          id="fidTolerance" v-model.number="settings.tolerance" type="range"
          min="0" max="1" step="0.05" class="field-input range" :disabled="running"
        />
      </SettingsField>
      <span class="field-hint">
        {{ images.length }} image{{ images.length === 1 ? '' : 's' }} will be searched.
        Calibration is not required.
      </span>
    </SettingsGroup>

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Matching">
        <SettingsField label="Polarity"
          hint="Whether marks are darker or lighter than the surrounding film. Auto tries both.">
          <SegmentedControl v-model="settings.polarity" :options="POLARITY_OPTIONS" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Output">
        <SettingsField hint="Existing accepted detections are preserved when disabled.">
          <template #label>Overwrite existing detections</template>
          <label class="checkbox-row">
            <input v-model="settings.overwrite" type="checkbox" class="checkbox" :disabled="running" /> Enabled
          </label>
        </SettingsField>
        <SettingsField hint="Uses the detected film frame to exclude scanner background, merging with an existing mask unless overwrite is enabled.">
          <template #label>Generate background masks</template>
          <label class="checkbox-row">
            <input v-model="settings.generateMasks" type="checkbox" class="checkbox" :disabled="running" /> Enabled
          </label>
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <div v-if="running" class="fid-progress">
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }" />
      </div>
      <span class="field-hint">Detecting {{ progress.done }} / {{ progress.total }}…</span>
    </div>
    <WarnBox v-if="error">{{ error }}</WarnBox>

    <template v-if="results">
      <SettingsGroup title="Results">
        <StatTiles :tiles="summaryTiles" />
        <DataTable
          :columns="RESULT_COLUMNS" :rows="resultRows" sort-key="confidence" sort-dir="asc"
          empty-text="No images were searched."
          @row-click="(r) => emit('open-image', r.id)"
        />
      </SettingsGroup>

      <SettingsGroup v-if="draftRows.length" title="Needs review">
        <span class="field-hint">Uncertain candidates are not stored until you accept them.</span>
        <DataTable :columns="DRAFT_COLUMNS" :rows="draftRows" sort-key="confidence" sort-dir="desc">
          <template #cell-imageName="{ row }">
            <button class="link-btn" @click.stop="emit('open-image', row.imageId)">{{ row.imageName }}</button>
          </template>
          <template #cell-actions="{ row }">
            <span class="fid-actions">
              <button
                class="btn btn-sm"
                :disabled="!canAccept(row.draft)"
                :title="canAccept(row.draft) ? '' : 'Nothing was measured here — open the image and place this mark by hand (right-click ▸ Mark fiducial)'"
                @click.stop="acceptDraft(row.draft)"
              >Accept</button>
              <button class="btn btn-sm" @click.stop="rejectDraft(row.draft)">Reject</button>
            </span>
          </template>
        </DataTable>
      </SettingsGroup>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">{{ results ? 'Done' : 'Cancel' }}</button>
      <button class="btn btn-primary" :disabled="running || !images.length" @click="run">
        {{ running ? 'Detecting…' : 'Detect Fiducials' }}
      </button>
    </template>
  </ModalShell>
</template>

<!-- Field-control classes (.field-input/.field-hint/.link-btn/.checkbox) style controls
     passed as slot content — compiled in THIS component's scope, so the shared sheet has
     to be imported here too (SettingsField's scoped styles don't reach slotted content). -->
<style scoped src="./ui/modal.css"></style>
<style scoped>
.fid-progress { display: flex; flex-direction: column; gap: 5px; }
.progress-track { height: 6px; background: var(--hover-bg); border-radius: 3px; overflow: hidden; }
.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.fid-actions { display: inline-flex; gap: 4px; }
.btn-sm { padding: 2px 6px; font-size: 10px; }
</style>
