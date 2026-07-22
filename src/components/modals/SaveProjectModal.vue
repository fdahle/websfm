<script setup>
// "Save project as…" — the only choice is whether to carry the recomputable-but-
// expensive caches (transcoded image blobs, depth maps, DEM/ortho products). The
// live sizes are shown because that is the only number that makes the trade-off
// decidable, and the 4 GB ZIP ceiling makes it occasionally forced.
import { ref, computed, onMounted } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import WarnBox from './ui/WarnBox.vue'
import * as opfs from '../../utils/opfs.js'
import {
  ARCHIVE_DERIVED_DIRS, shouldArchivePath, archiveSizeVerdict, formatBytes,
} from '../../core/io/projectArchive.js'

const props = defineProps({
  projectId: { type: String, required: true },
  projectName: { type: String, default: 'Project' },
})
const emit = defineEmits(['close', 'run'])

const includeDerived = ref(true)
const sizes = ref(null)   // { all, derived } bytes, or null while measuring

onMounted(async () => {
  let all = 0
  let derived = 0
  for await (const { relPath, file } of opfs.walkProjectFiles(props.projectId)) {
    if (!shouldArchivePath(relPath)) continue
    all += file.size
    if (ARCHIVE_DERIVED_DIRS.includes(relPath.split('/')[0])) derived += file.size
  }
  sizes.value = { all, derived }
})

const estimate = computed(() => {
  if (!sizes.value) return null
  return includeDerived.value ? sizes.value.all : sizes.value.all - sizes.value.derived
})
const tooLarge = computed(() => estimate.value != null && !archiveSizeVerdict(estimate.value).ok)
</script>

<template>
  <ModalShell title="Save project as…" @close="emit('close')">
    <p class="intro">
      Writes a single <code>.websfm</code> file containing this project — source images,
      features, matches, reconstruction and ground control. It can be reopened on any
      machine, in any browser.
    </p>

    <SettingsField
      hint="Transcoded image previews, depth maps and DEM/ortho products. Excluding them
            makes a much smaller file; websfm rebuilds them on demand."
    >
      <label class="check-row">
        <input v-model="includeDerived" type="checkbox" />
        <span>Include cached &amp; derived data</span>
      </label>
    </SettingsField>

    <div class="size-row">
      <span v-if="!sizes" class="dim">Measuring project size…</span>
      <template v-else>
        <span>Uncompressed size: <strong>{{ formatBytes(estimate) }}</strong></span>
        <span v-if="sizes.derived" class="dim">
          (cached &amp; derived data: {{ formatBytes(sizes.derived) }})
        </span>
      </template>
    </div>

    <WarnBox v-if="tooLarge">
      This project is too large for a single project file — the ZIP format caps at 4 GB.
      <template v-if="includeDerived"> Try excluding cached &amp; derived data.</template>
    </WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="!sizes || tooLarge"
        @click="emit('run', { includeDerived })"
      >
        Save…
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.intro {
  margin: 0 0 16px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.size-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  margin-top: 4px;
}
.dim { color: var(--text-dim); }
</style>
