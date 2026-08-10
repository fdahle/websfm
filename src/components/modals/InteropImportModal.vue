<script setup>
import { computed, reactive } from 'vue'
import ModalShell from './ui/ModalShell.vue'

const props = defineProps({ session: { type: Object, required: true } })
const emit = defineEmits(['close', 'run'])
const db = computed(() => props.session.database)
const ready = computed(() => props.session.status === 'ready')
const options = reactive({
  images: false,
  calibration: !!props.session.database,
  features: !!props.session.database?.hasKeypoints,
  descriptors: !!props.session.database?.hasDescriptors,
  matches: !!props.session.database?.hasVerifiedMatches,
  matchSource: props.session.database?.hasVerifiedMatches ? 'verified' : 'raw',
  replaceMatches: false,
  modelIds: props.session.models?.filter((m) => m.complete).slice(0, 1).map((m) => m.externalId) ?? [],
})
const canImport = computed(() => ready.value && (
  options.images || options.calibration || options.features || options.matches || options.modelIds.length
))
</script>

<template>
  <ModalShell title="Import SfM Project" @close="emit('close')">
    <div v-if="session.status === 'inspecting'" class="notice">Inspecting {{ session.sourceName }}…</div>
    <div v-else-if="session.status === 'error'" class="notice error">{{ session.error }}</div>
    <template v-else>
      <div class="source-head">
        <div><strong>{{ session.format }}</strong><span>{{ session.sourceName }}</span></div>
        <span v-if="db">{{ (db.bytes / 1048576).toFixed(1) }} MB database</span>
      </div>

      <div class="stats">
        <div><strong>{{ session.counts.externalImages }}</strong><span>{{ db ? 'database images' : 'source cameras' }}</span></div>
        <div><strong>{{ session.counts.matchedImages }}</strong><span>already matched</span></div>
        <div><strong>{{ session.counts.bundledImages }}</strong><span>bundled images</span></div>
        <div><strong>{{ session.models.length }}</strong><span>sparse models</span></div>
      </div>

      <p v-if="db && !session.models.length" class="hint">A COLMAP database stores cameras and feature relationships, but not image pixels or reconstructed 3D points.</p>
      <ul v-if="session.warnings.length" class="warnings">
        <li v-for="warning in session.warnings" :key="warning">{{ warning }}</li>
      </ul>
      <p v-if="session.error" class="notice error">{{ session.error }}</p>

      <fieldset v-if="db">
        <legend>Database contents</legend>
        <label><input v-model="options.calibration" type="checkbox" /> Camera calibration ({{ db.cameras.length }} groups)</label>
        <label><input v-model="options.features" type="checkbox" /> Keypoints ({{ db.features.length }} images)</label>
        <label :class="{ disabled: !options.features || !db.hasDescriptors }"><input v-model="options.descriptors" type="checkbox" :disabled="!options.features || !db.hasDescriptors" /> Compatible descriptors</label>
        <label :class="{ disabled: !options.features }"><input v-model="options.matches" type="checkbox" :disabled="!options.features" /> Matches (requires the imported keypoint indices)</label>
        <div v-if="options.matches" class="inline-options">
          <label><input v-model="options.matchSource" type="radio" value="verified" :disabled="!db.hasVerifiedMatches" /> Verified inliers</label>
          <label><input v-model="options.matchSource" type="radio" value="raw" :disabled="!db.hasRawMatches" /> Raw matches</label>
          <label><input v-model="options.replaceMatches" type="checkbox" /> Replace conflicting pairs</label>
        </div>
      </fieldset>

      <fieldset v-if="session.bundledImages.length">
        <legend>Images</legend>
        <label><input v-model="options.images" type="checkbox" /> Import {{ session.bundledImages.length }} bundled image(s) missing from this project</label>
      </fieldset>

      <fieldset v-if="session.models.length">
        <legend>Sparse reconstructions</legend>
        <label v-for="model in session.models" :key="model.externalId" :class="{ disabled: !model.complete }">
          <input v-model="options.modelIds" type="checkbox" :value="model.externalId" :disabled="!model.complete" />
          {{ model.name }} — {{ model.registeredImages }} cameras, {{ model.pointCount }} points
          <span v-if="!model.complete"> (incomplete)</span>
        </label>
      </fieldset>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canImport" @click="emit('run', { ...options, modelIds: [...options.modelIds] })">
        {{ session.status === 'importing' ? 'Importing…' : 'Import selected' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.source-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:14px; }
.source-head div { display:flex; flex-direction:column; gap:3px; }
.source-head span, .hint { color:var(--text-muted); font-size:12px; }
.stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:14px; }
.stats div { padding:9px; border:1px solid var(--border); border-radius:5px; display:flex; flex-direction:column; }
.stats strong { font-size:17px; }.stats span { color:var(--text-muted); font-size:11px; }
fieldset { border:1px solid var(--border); border-radius:5px; margin:12px 0 0; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
legend { color:var(--text-muted); font-size:12px; padding:0 5px; }
label { font-size:13px; }.disabled { opacity:.5; }.inline-options { margin-left:23px; display:flex; gap:14px; flex-wrap:wrap; }
.warnings { margin:8px 0; padding-left:20px; color:var(--warning, #b87800); font-size:12px; }
.notice { padding:18px 4px; }.error { color:var(--danger, #c33); }
</style>
