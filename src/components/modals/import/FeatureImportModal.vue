<script setup>
import { computed, reactive } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import { pluralize } from '../../../core/textFormat.js'
import { useFeatureImport } from '../../../composables/useFeatureImport.js'

// Import ▸ Keypoints & Matches: what the files hold, and what of it to import
// (composables/useFeatureImport.js).
const { featureImportSession: session, closeFeatureImport, commitFeatureImport } = useFeatureImport()
const s = computed(() => session.value)
const ready = computed(() => s.value?.status === 'ready')
const busy = computed(() => s.value?.status === 'importing')
const counts = computed(() => s.value?.counts ?? {})
const options = reactive({
  keypoints: true,
  matches: true,
  verify: true,
  replaceMatches: false,
})
// Matches on the files' own keypoints need those keypoints imported.
const matchesWithoutKeypoints = computed(() => counts.value.pairs - counts.value.ownPairs)
const matchesReason = computed(() =>
  !counts.value.pairs
    ? 'The files hold no matches for images in this project'
    : !options.keypoints && !matchesWithoutKeypoints.value
      ? 'Import the keypoints too: these matches refer to them'
      : null,
)
const keypointsReason = computed(() =>
  counts.value.keypointImages ? null : 'The files hold no keypoints for images in this project',
)
const canImport = computed(
  () => ready.value && ((options.keypoints && !keypointsReason.value) || (options.matches && !matchesReason.value)),
)
const importReason = computed(() =>
  busy.value
    ? 'Wait for the import to finish'
    : !ready.value
      ? 'Still reading the files'
      : canImport.value
        ? null
        : 'Choose something to import',
)
function run() {
  commitFeatureImport({
    keypoints: options.keypoints && !keypointsReason.value,
    matches: options.matches && !matchesReason.value,
    verify: options.verify,
    replaceMatches: options.replaceMatches,
  })
}
</script>

<template>
  <ModalShell v-if="s" title="Import Keypoints & Matches" @close="closeFeatureImport">
    <div v-if="s.status === 'inspecting'" class="notice">Reading {{ s.sourceName }}…</div>
    <div v-else-if="s.status === 'error' && !s.counts" class="notice error">{{ s.error }}</div>
    <template v-else>
      <div class="stats">
        <div>
          <strong>{{ counts.keypointImages }}</strong
          ><span>images with keypoints</span>
        </div>
        <div>
          <strong>{{ counts.keypoints.toLocaleString() }}</strong
          ><span>keypoints</span>
        </div>
        <div>
          <strong>{{ counts.pairs }}</strong
          ><span>image pairs</span>
        </div>
        <div>
          <strong>{{ counts.matches.toLocaleString() }}</strong
          ><span>matches</span>
        </div>
      </div>
      <ul v-if="s.warnings.length" class="warnings">
        <li v-for="warning in s.warnings" :key="warning">{{ warning }}</li>
      </ul>
      <p v-if="s.error" class="notice error">{{ s.error }}</p>

      <fieldset>
        <legend>Import</legend>
        <label :title="keypointsReason" :class="{ disabled: keypointsReason }"
          ><input v-model="options.keypoints" type="checkbox" :disabled="!!keypointsReason" :title="keypointsReason" />
          Keypoints ({{ pluralize(counts.keypointImages, 'image') }})</label
        >
        <p v-if="options.keypoints && counts.replaced" class="hint indent">
          {{ pluralize(counts.replaced, 'image') }} already {{ counts.replaced === 1 ? 'has' : 'have' }} keypoints: they
          are replaced, and the matches of those images are removed.
        </p>
        <p v-if="options.keypoints && !keypointsReason" class="hint indent">
          The files carry no descriptors, so Match Features cannot match these images: import their matches too.
        </p>
        <label :title="matchesReason" :class="{ disabled: matchesReason }"
          ><input v-model="options.matches" type="checkbox" :disabled="!!matchesReason" :title="matchesReason" />
          Matches ({{ pluralize(counts.pairs, 'pair') }})</label
        >
        <p v-if="options.matches && counts.onExisting" class="hint indent">
          {{ pluralize(counts.onExisting, 'pair') }} refer to keypoints already in the project.
        </p>
        <div v-if="options.matches && !matchesReason" class="inline-options">
          <label title="F-RANSAC and the acceptance rules of Match Features, at their defaults"
            ><input v-model="options.verify" type="checkbox" /> Verify geometrically, as Match Features does</label
          >
          <label title="A pair the project already has keeps its matches unless this is on"
            ><input v-model="options.replaceMatches" type="checkbox" /> Replace pairs already matched</label
          >
        </div>
        <p v-if="options.matches && !options.verify" class="hint indent">
          Every match is taken as correct: use this only for matches another tool has already verified.
        </p>
      </fieldset>
      <p v-if="busy && s.progress" class="hint">Verifying pair {{ s.progress.done }} of {{ s.progress.total }}…</p>
    </template>

    <template #footer>
      <button
        class="btn"
        :disabled="busy"
        :title="busy ? 'Wait for the import to finish' : null"
        @click="closeFeatureImport"
      >
        Cancel
      </button>
      <button class="btn btn-primary" :disabled="!canImport || busy" :title="importReason" @click="run">
        {{ busy ? 'Importing…' : 'Import selected' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 14px;
}
.stats div {
  padding: 9px;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  display: flex;
  flex-direction: column;
}
.stats strong {
  font-size: 17px;
}
.stats span,
.hint {
  color: var(--text-dim);
  font-size: 12px;
}
.hint {
  margin: 0;
}
.indent {
  margin-left: 23px;
}
fieldset {
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  margin: 12px 0 0;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
legend {
  color: var(--text-dim);
  font-size: 12px;
  padding: 0 5px;
}
label {
  font-size: 13px;
}
.disabled {
  opacity: 0.5;
}
.inline-options {
  margin-left: 23px;
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.warnings {
  margin: 8px 0;
  padding-left: 20px;
  color: var(--warning, #b87800);
  font-size: 12px;
}
.notice {
  padding: 18px 4px;
}
.error {
  color: var(--danger, #c33);
}
</style>
