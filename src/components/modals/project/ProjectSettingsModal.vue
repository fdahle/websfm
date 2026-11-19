<script setup>
import { computed, onMounted, ref } from 'vue'
import CrsPicker from '../../controls/CrsPicker.vue'
import CrsSuggestion from '../ui/CrsSuggestion.vue'
import ModalShell from '../ui/ModalShell.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import { formatBytes, ARCHIVE_DERIVED_DIRS } from '../../../core/io/projectArchive.js'
import { FOLDER_BROWSERS, isFolderProject } from '../../../core/io/folderProject.js'
import { msg } from '../../../core/i18n/index.js'
import * as opfs from '../../../utils/opfs.js'
import { confirmDialog } from '../../../composables/useConfirmations.js'
import { useI18n } from '../../../composables/useI18n.js'
import { version as appVersion } from '../../../../package.json'

const props = defineProps({
  project: { type: Object, required: true },
  clearDerived: { type: Function, required: true },
  // Projected CRS derived from the camera positions while the CRS is geographic
  // (reconstruction store `crsSuggestion`); null otherwise.
  crsSuggestion: { type: Object, default: null },
  // Chromium-only (showDirectoryPicker): moving between browser storage and a folder.
  folderSupported: { type: Boolean, default: false },
  // A run is in flight (App's workInFlight): the capture type, which runs read, waits.
  busy: { type: Boolean, default: false },
})
const emit = defineEmits([
  'close',
  'rename',
  'set-crs',
  'set-scene-type',
  'apply-crs-suggestion',
  'move-to-folder',
  'move-to-browser',
  'export-file',
])
const { t, tx, locale } = useI18n()
const inFolder = computed(() => isFolderProject(props.project))
const sceneType = computed(() => (props.project.sceneType === 'object' ? 'object' : 'aerial'))
const sceneOptions = computed(() =>
  ['aerial', 'object'].map((id) => ({
    id,
    label: msg(`projectSettings.capture.${id}`),
    disabled: props.busy && id !== sceneType.value,
    reason: msg('projectSettings.capture.busy'),
  })),
)
// The project file it was last written to (useProjectsStore exportProject), its backup.
const lastExported = computed(() => {
  const d = props.project.lastExportedAt ? new Date(props.project.lastExportedAt) : null
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString(locale.value, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null
})

const name = ref(props.project.name || '')
const measuring = ref(true)
const clearing = ref(false)
// The last failure, a message; null when there is none.
const error = ref(null)
const sections = ref([])
const totalBytes = computed(() => sections.value.reduce((sum, row) => sum + row.bytes, 0))
const derivedBytes = computed(() =>
  sections.value.filter((row) => ARCHIVE_DERIVED_DIRS.includes(row.id)).reduce((sum, row) => sum + row.bytes, 0),
)

// A project folder's catalogue key; a folder without one shows by its own name.
const SECTION_KEYS = {
  'images': 'images',
  'images-derived': 'imagesDerived',
  'keypoints': 'keypoints',
  'matches': 'matches',
  'depthmaps': 'depthmaps',
  'products': 'products',
  'project': 'project',
}
const sectionLabel = (id) => (SECTION_KEYS[id] ? t(`projectSettings.storage.section.${SECTION_KEYS[id]}`) : id)
const errorText = (err) => String(err?.message ?? err)

async function measure() {
  measuring.value = true
  error.value = null
  try {
    const totals = new Map()
    for await (const { relPath, file } of opfs.walkProjectFiles(props.project.id)) {
      const parts = relPath.split('/')
      const id = parts.length > 1 ? parts[0] : 'project'
      totals.set(id, (totals.get(id) || 0) + file.size)
    }
    sections.value = [...totals.entries()].map(([id, bytes]) => ({ id, bytes })).sort((a, b) => b.bytes - a.bytes)
  } catch (err) {
    error.value = msg('projectSettings.storage.measureFailed', { error: errorText(err) })
  } finally {
    measuring.value = false
  }
}

function commitName() {
  const value = name.value.trim()
  if (!value) {
    name.value = props.project.name
    return
  }
  if (value !== props.project.name) emit('rename', value)
}

async function onClearDerived() {
  if (!derivedBytes.value) return
  if (
    !(await confirmDialog({
      title: t('projectSettings.storage.confirmTitle'),
      message: t('projectSettings.storage.confirmMessage', { size: formatBytes(derivedBytes.value) }),
      confirmLabel: t('projectSettings.storage.confirmLabel'),
    }))
  )
    return
  clearing.value = true
  error.value = null
  try {
    await props.clearDerived()
    await measure()
  } catch (err) {
    error.value = msg('projectSettings.storage.clearFailed', { error: errorText(err) })
  } finally {
    clearing.value = false
  }
}

onMounted(measure)
</script>

<template>
  <!-- Flush: each section carries its own padding and divider. -->
  <ModalShell class="project-settings" :title="t('projectSettings.title')" width="520px" flush @close="emit('close')">
    <div class="sections">
      <section class="section">
        <h3>{{ t('projectSettings.project') }}</h3>
        <label class="field">
          <span>{{ t('projectSettings.name') }}</span>
          <input v-model="name" maxlength="80" @change="commitName" @keydown.enter="commitName" />
        </label>
        <div class="capture">
          <div class="readout-row">
            <span>{{ t('projectSettings.capture.label') }}</span>
            <SegmentedControl
              :model-value="sceneType"
              :options="sceneOptions"
              @update:model-value="(v) => v !== sceneType && emit('set-scene-type', v)"
            />
          </div>
          <p>{{ t('projectSettings.capture.desc') }}</p>
        </div>
        <div class="readout-row">
          <span>{{ t('projectSettings.createdWith') }}</span>
          <strong>{{
            project.createdWithVersion
              ? t('projectSettings.version', { version: project.createdWithVersion })
              : t('projectSettings.unknown')
          }}</strong>
        </div>
        <div class="readout-row">
          <span>{{ t('projectSettings.currentApp') }}</span>
          <strong>{{ t('projectSettings.version', { version: appVersion }) }}</strong>
        </div>
      </section>

      <!-- Where the project is kept, and the ways to change that: the one place a
           user looks for it, so the move lives here as well as in the ⋯ menu. -->
      <section class="section">
        <h3>{{ t('projectSettings.saved.title') }}</h3>
        <div class="readout-row">
          <span>{{ t('projectSettings.saved.location') }}</span>
          <strong>{{
            !inFolder
              ? t('projectSettings.saved.thisBrowser')
              : project.folderName
                ? t('projectSettings.saved.locationFolder', { name: project.folderName })
                : t('projectSettings.saved.locationFolderUnnamed')
          }}</strong>
        </div>
        <div class="readout-row">
          <span>{{ t('projectSettings.saved.lastExported') }}</span>
          <strong>{{ lastExported ?? t('projectSettings.saved.never') }}</strong>
        </div>
        <p v-if="inFolder">{{ t('projectSettings.saved.folder') }}</p>
        <p v-else>
          {{ t('projectSettings.saved.browser') }}
          {{
            folderSupported
              ? t('projectSettings.saved.canMove')
              : t('projectSettings.saved.otherBrowsers', { browsers: FOLDER_BROWSERS })
          }}
        </p>
        <div class="action-row">
          <template v-if="folderSupported">
            <button v-if="!inFolder" class="btn" @click="emit('move-to-folder')">
              {{ t('projectSettings.saved.moveToFolder') }}
            </button>
            <button v-else class="btn" @click="emit('move-to-browser')">
              {{ t('projectSettings.saved.moveToBrowser') }}
            </button>
          </template>
          <button class="btn" @click="emit('export-file')">{{ t('projectSettings.saved.exportFile') }}</button>
        </div>
      </section>

      <section v-if="project.sceneType !== 'object'" class="section">
        <h3>{{ t('projectSettings.crs.title') }}</h3>
        <p>{{ t('projectSettings.crs.desc') }}</p>
        <CrsPicker :model-value="project.crs || 'EPSG:4326'" @update:model-value="emit('set-crs', $event)" />
        <CrsSuggestion
          v-if="crsSuggestion"
          context="settings"
          :suggestion="crsSuggestion"
          :current-crs="project.crs || 'EPSG:4326'"
          @apply="emit('apply-crs-suggestion', $event)"
        />
      </section>

      <section class="section">
        <div class="section-heading">
          <div>
            <h3>{{ t('projectSettings.storage.title') }}</h3>
            <p>{{ t('projectSettings.storage.desc') }}</p>
          </div>
          <strong v-if="!measuring">{{ formatBytes(totalBytes) }}</strong>
        </div>
        <div v-if="measuring" class="muted">{{ t('projectSettings.storage.calculating') }}</div>
        <div v-else class="breakdown">
          <div v-for="row in sections" :key="row.id" class="breakdown-row">
            <span>{{ sectionLabel(row.id) }}</span>
            <span>{{ formatBytes(row.bytes) }}</span>
          </div>
          <div v-if="!sections.length" class="muted">{{ t('projectSettings.storage.none') }}</div>
        </div>
        <div class="clear-row">
          <div>
            <span>{{ t('projectSettings.storage.recomputable') }}</span>
            <small>{{ t('projectSettings.storage.recomputableDesc') }}</small>
          </div>
          <button
            class="btn danger"
            :disabled="clearing || measuring || !derivedBytes"
            :title="
              clearing
                ? t('projectSettings.storage.clearing')
                : measuring
                  ? t('projectSettings.storage.measuring')
                  : !derivedBytes
                    ? t('projectSettings.storage.nothing')
                    : null
            "
            @click="onClearDerived"
          >
            {{
              derivedBytes
                ? t('projectSettings.storage.clear', { size: formatBytes(derivedBytes) })
                : t('projectSettings.storage.confirmLabel')
            }}
          </button>
        </div>
        <div v-if="error" class="error" aria-live="polite">{{ tx(error) }}</div>
      </section>
    </div>
  </ModalShell>
</template>

<style scoped>
/* One step above the other settings-family dialogs (z 200), as before; two classes
   outrank the shell's `.overlay`. */
.overlay.project-settings {
  z-index: 210;
}
.sections {
  padding: 4px 0;
}
.section {
  padding: 14px 16px;
}
.section + .section {
  border-top: 1px solid var(--panel-border);
}
h3 {
  font-size: 12px;
  font-weight: 650;
  margin-bottom: 8px;
  color: var(--text);
}
p,
.muted,
small {
  display: block;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-dim);
}
p {
  margin-bottom: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 10px;
}
.field input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
.readout-row,
.breakdown-row,
.clear-row,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.readout-row {
  padding: 5px 0;
  font-size: 12px;
  color: var(--text-dim);
}
.readout-row strong,
.section-heading strong {
  color: var(--text);
  font-size: 12px;
  font-weight: 550;
}
.section-heading {
  align-items: flex-start;
}
.section-heading h3 {
  margin-bottom: 2px;
}
.breakdown {
  margin-top: 8px;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  overflow: hidden;
}
.breakdown-row {
  padding: 6px 8px;
  font-size: 11px;
}
.breakdown-row + .breakdown-row {
  border-top: 1px solid var(--panel-border);
}
.breakdown-row span:last-child {
  color: var(--text-dim);
}
.breakdown .muted {
  padding: 8px;
}
.clear-row {
  margin-top: 12px;
}
/* The capture type: its switch on the row, what it changes under it. */
.capture p {
  margin: 0 0 6px;
}
.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.clear-row > div > span {
  display: block;
  font-size: 12px;
}
.btn {
  white-space: nowrap;
}
.btn.danger:hover:not(:disabled) {
  color: #e66;
  border-color: #e66;
  background: rgba(220, 50, 50, 0.1);
}
.error {
  margin-top: 10px;
  color: #e66;
  font-size: 11px;
}
</style>
