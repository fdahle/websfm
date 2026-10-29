<script setup>
// Export project file — the only choice is whether to carry the recomputable-but-
// expensive data (transcoded image blobs, depth maps, DEM/ortho products). The live
// sizes are shown because that is the only number that makes the trade-off decidable.
// There is no size ceiling (ZIP64 past 4 GB, utils/zip.js); a browser without a save
// dialog assembles the file before it downloads, which the dialog says.
import { ref, computed, onMounted } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import WarnBox from '../ui/WarnBox.vue'
import * as opfs from '../../../utils/opfs.js'
import { ARCHIVE_DERIVED_DIRS, shouldArchivePath, formatBytes } from '../../../core/io/projectArchive.js'

const props = defineProps({
  projectId: { type: String, required: true },
  projectName: { type: String, default: 'Project' },
})
const emit = defineEmits(['close', 'run'])

const includeDerived = ref(true)
const sizes = ref(null) // { all, derived } bytes, or null while measuring

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
// Firefox and Safari: no save dialog, so the file is gathered before it downloads.
const buffered = typeof window === 'undefined' || !window.showSaveFilePicker
// Past this, a gathered file is worth a word of warning: it needs that much room
// while it is put together (utils/projectFile.js openArchiveSink).
const BUFFERED_WARN_BYTES = 2 * 1024 ** 3
</script>

<template>
  <ModalShell title="Export project file" @close="emit('close')">
    <p class="intro">
      Writes the whole project into one <code>.websfm</code> file: source images, features, matches, the reconstruction,
      clouds and meshes, ground control and measurements. Open it on any machine, in any browser, with Open existing ▸
      Project file. The project itself stays where it is and keeps saving there.
    </p>

    <SettingsField
      hint="Left out, the file is much smaller. Image previews are made again when needed; depth maps, DEMs and
            orthophotos are not, and have to be built again."
    >
      <label class="check-row">
        <input v-model="includeDerived" type="checkbox" />
        <span>Include depth maps, DEMs, orthophotos and image previews</span>
      </label>
    </SettingsField>

    <div class="size-row">
      <span v-if="!sizes" class="dim">Measuring project size…</span>
      <template v-else>
        <span
          >Uncompressed size: <strong>{{ formatBytes(estimate) }}</strong></span
        >
        <span v-if="sizes.derived" class="dim">
          (depth maps, DEMs, orthophotos and previews: {{ formatBytes(sizes.derived) }})
        </span>
      </template>
    </div>

    <WarnBox v-if="buffered && estimate > BUFFERED_WARN_BYTES">
      This browser has no save dialog, so the file is put together before it downloads, and needs that much room while
      it is. For a project this large, leave the depth maps and products out, or use Chrome or Edge, which write the
      file straight to disk.
    </WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!sizes" @click="emit('run', { includeDerived })">Export…</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
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
.dim {
  color: var(--text-dim);
}
</style>
