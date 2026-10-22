<script setup>
import { ref, computed } from 'vue'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { maskFromFile } from '../../../workers/computeClient.js'
import ImageThumb from '../../controls/ImageThumb.vue'
import ModalShell from '../ui/ModalShell.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { maskGroups } from '../../../utils/maskGroups.js'
import { MASK_IMPORT_DEFAULTS } from '../../../core/defaults.user.js'

// Central mask manager. Lists every image grouped by resolution and lets you
// import a file as a mask, import a folder of per-image masks paired by name,
// apply one mask to a whole resolution group (or all images), edit in the viewer,
// or clear. Files are decoded on the worker pool, so TIFF masks work too. Painted/red regions are EXCLUDED — they
// are dropped by SIFT detection and excluded from the dense/MVS cloud. Masks
// take effect on the next detect/dense run.
const emit = defineEmits(['close', 'edit'])

const imagesStore = useImagesStore()
const { updateMask } = imagesStore

const fileInput = ref(null)
const folderInput = ref(null)
const busy = ref(false)
let fileResolver = null

// Import folder: the chosen files, how they pair with the images (shown before
// anything is written), and the progress of the import.
const folderFiles = ref(null)
const folderPlan = ref(null)
const existing = ref(MASK_IMPORT_DEFAULTS.existing)
const progress = ref(null)

// Images by resolution (utils/maskGroups.js, shared with Auto Mask); images
// without known dims fall into 'unknown'.
const grouping = computed(() => maskGroups(imagesStore.images))

function pickFile() {
  return new Promise((resolve) => {
    fileResolver = resolve
    fileInput.value.value = ''
    fileInput.value.click()
  })
}
function onFile(e) {
  const f = e.target.files?.[0] || null
  fileResolver?.(f)
  fileResolver = null
}

// Resolve target dimensions: prefer EXIF meta, else decode the image natural size.
async function dimsOf(img) {
  if (img.meta?.width && img.meta?.height) return { w: img.meta.width, h: img.meta.height }
  const bmp = await createImageBitmap(await (await fetch(img.url)).blob())
  const d = { w: bmp.width, h: bmp.height }
  bmp.close()
  return d
}

async function importForImage(img) {
  const f = await pickFile()
  if (!f) return
  busy.value = true
  try {
    const { w, h } = await dimsOf(img)
    updateMask(img.id, await maskFromFile(f, w, h))
  } finally {
    busy.value = false
  }
}

// Same-resolution group: rasterize the source once, copy to every image.
async function importForGroup(group) {
  const f = await pickFile()
  if (!f) return
  busy.value = true
  try {
    const mask = await maskFromFile(f, group.w, group.h)
    for (const img of group.images) updateMask(img.id, mask)
  } finally {
    busy.value = false
  }
}

// Apply one mask to all images, rescaled per resolution group.
async function importForAll() {
  const f = await pickFile()
  if (!f) return
  busy.value = true
  try {
    for (const g of grouping.value.sizedGroups) {
      const mask = await maskFromFile(f, g.w, g.h)
      for (const img of g.images) updateMask(img.id, mask)
    }
  } finally {
    busy.value = false
  }
}

function pickFolder() {
  folderInput.value.value = ''
  folderInput.value.click()
}
function onFolder(e) {
  const files = Array.from(e.target.files || [])
  if (!files.length) return
  folderFiles.value = files
  folderPlan.value = imagesStore.planMaskImport(files)
}
function cancelFolder() {
  folderFiles.value = null
  folderPlan.value = null
}
async function runFolderImport() {
  busy.value = true
  progress.value = { done: 0, total: folderPlan.value.pairs.length }
  try {
    await imagesStore.importMaskFiles(folderFiles.value, {
      existing: existing.value,
      onProgress: (done, total) => (progress.value = { done, total }),
    })
  } finally {
    busy.value = false
    progress.value = null
    cancelFolder()
  }
}
// "12 files matched no image: a.png, b.png, c.png …"
function fileList(names, max = 3) {
  return names.slice(0, max).join(', ') + (names.length > max ? ' …' : '')
}

function clearGroup(group) {
  for (const img of group.images) updateMask(img.id, null)
}
function clearImage(img) {
  updateMask(img.id, null)
}
function edit(img) {
  emit('edit', img.id)
}
</script>

<template>
  <!-- Flush and a fixed height: the sub-bar stays put while the group list scrolls. -->
  <ModalShell
    class="mask-manager"
    title="Masks"
    width="760px"
    height="80vh"
    flush
    :scroll="false"
    @close="emit('close')"
  >
    <div class="subbar">
      <button class="btn" :disabled="busy || !grouping.sizedGroups.length" @click="importForAll">
        Import &amp; apply to all…
      </button>
      <button
        class="btn"
        :disabled="busy || !imagesStore.images.length"
        title="One mask file per image, paired by file name"
        @click="pickFolder"
      >
        Import folder…
      </button>
      <span class="hint">{{ grouping.hint }}</span>
    </div>

    <div v-if="folderPlan" class="folder-plan">
      <div class="plan-line">
        <strong>{{ folderPlan.pairs.length }}</strong> of {{ imagesStore.images.length }} images have a mask file
        <template v-if="folderPlan.imagesWithout"> · {{ folderPlan.imagesWithout }} without</template>
      </div>
      <div v-if="folderPlan.unmatched.length" class="plan-note">
        {{ folderPlan.unmatched.length }} file{{ folderPlan.unmatched.length !== 1 ? 's' : '' }} matched no image:
        {{ fileList(folderPlan.unmatched) }}
      </div>
      <div v-if="folderPlan.duplicates.length" class="plan-note">
        {{ folderPlan.duplicates.length }} further file{{ folderPlan.duplicates.length !== 1 ? 's' : '' }} for an image
        left out: {{ fileList(folderPlan.duplicates) }}
      </div>
      <div class="plan-actions">
        <span class="opt-label"><FieldHelp op="masks" param="importExisting">If a mask exists</FieldHelp>:</span>
        <label class="opt"><input v-model="existing" type="radio" value="replace" :disabled="busy" /> Replace</label>
        <label class="opt"><input v-model="existing" type="radio" value="merge" :disabled="busy" /> Merge</label>
        <span class="spacer"></span>
        <span v-if="progress" class="hint">{{ progress.done }} / {{ progress.total }}</span>
        <button class="btn sm ghost" :disabled="busy" @click="cancelFolder">Cancel</button>
        <button class="btn sm" :disabled="busy || !folderPlan.pairs.length" @click="runFolderImport">
          Import {{ folderPlan.pairs.length }} mask{{ folderPlan.pairs.length !== 1 ? 's' : '' }}
        </button>
      </div>
    </div>

    <div class="list">
      <div v-if="!imagesStore.images.length" class="empty">No images.</div>

      <div v-for="group in grouping.groups" :key="group.key" class="group">
        <div class="group-head">
          <span class="group-title">{{ group.label }}</span>
          <span class="group-count">{{ group.images.length }} image{{ group.images.length !== 1 ? 's' : '' }}</span>
          <div class="group-actions">
            <button
              class="btn sm"
              :disabled="busy || !group.w"
              :title="group.w ? '' : 'Unknown size — open an image to draw a mask'"
              @click="importForGroup(group)"
            >
              Import &amp; apply to group…
            </button>
            <button class="btn sm ghost" :disabled="busy" @click="clearGroup(group)">Clear group</button>
          </div>
        </div>

        <div class="rows">
          <div v-for="img in group.images" :key="img.id" class="row">
            <ImageThumb class="thumb" :image="img" />
            <span class="name" :title="img.name">{{ img.name }}</span>
            <span class="badge" :class="{ on: !!img.mask }">{{ img.mask ? 'Masked' : 'None' }}</span>
            <div class="row-actions">
              <button class="btn sm" :disabled="busy" @click="importForImage(img)">Import…</button>
              <button class="btn sm" @click="edit(img)">Edit</button>
              <button class="btn sm ghost" :disabled="busy || !img.mask" @click="clearImage(img)">Clear</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <input ref="fileInput" type="file" accept="image/*,.tif,.tiff" hidden @change="onFile" />
    <input ref="folderInput" type="file" webkitdirectory multiple hidden @change="onFolder" />
  </ModalShell>
</template>

<style scoped>
.subbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.hint {
  font-size: 11px;
  color: var(--text-dim);
}
.folder-plan {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--panel-border);
  background: var(--panel);
  font-size: 12px;
  flex-shrink: 0;
}
.plan-note {
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.plan-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}
.plan-actions .spacer {
  flex: 1;
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.opt input {
  accent-color: var(--accent);
}
.opt-label {
  color: var(--text-dim);
}

.list {
  flex: 1;
  overflow: auto;
  min-height: 0;
  background: var(--bg);
}
.empty {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}

.group {
  border-bottom: 1px solid var(--panel-border);
}
.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 1;
  border-bottom: 1px solid var(--panel-border);
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.group-count {
  font-size: 11px;
  color: var(--text-dim);
}
.group-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--panel-border);
}
.row:last-child {
  border-bottom: none;
}
.thumb {
  width: 48px;
  height: 36px;
  object-fit: cover;
  border-radius: 3px;
  background: #000;
  flex-shrink: 0;
}
.name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg);
  color: var(--text-dim);
  border: 1px solid var(--panel-border);
}
.badge.on {
  background: rgba(255, 80, 80, 0.18);
  color: #ff9a9a;
  border-color: rgba(255, 80, 80, 0.4);
}
.row-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.btn {
  background: var(--accent);
  border: none;
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 5px;
  cursor: pointer;
}
.btn.sm {
  font-size: 11px;
  padding: 4px 9px;
}
.btn.ghost {
  background: var(--bg);
  color: var(--text-dim);
  border: 1px solid var(--panel-border);
}
.btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
.btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
