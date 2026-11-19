<script setup>
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import I18nText from '../../I18nText.vue'
import { computed, onMounted, ref } from 'vue'
import { useGlossarySettings } from '../../../composables/useGlossarySettings.js'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'
import { useViewerSettings } from '../../../composables/useViewerSettings.js'
import { useUiSettings } from '../../../composables/useUiSettings.js'
import { useBrowserWarning } from '../../../composables/useBrowserWarning.js'
import { useMobileWarning } from '../../../composables/useMobileWarning.js'
import { useMapSettings } from '../../../composables/useMapSettings.js'
import { useI18n } from '../../../composables/useI18n.js'
import { useSettingsTransfer } from '../../../composables/useSettingsTransfer.js'
import { dialogPresets, loadDialogPresets, writeDialogPresets } from '../../../composables/dialogPresets.js'
import { renamePreset, withoutPreset } from '../../../core/dialogSettings.js'
import { getGuideDoc } from '../../../core/help/guide.js'
import { provideStepLayout } from '../../../composables/useStepLayout.js'
import { BASEMAPS, SATELLITE } from '../../../core/basemaps.js'
import { PLANNED_LANGUAGES, msg } from '../../../core/i18n/index.js'
import { formatBytes } from '../../../core/io/projectArchive.js'
import { MODELS, MODEL_CACHE_NAME, modelUrl } from '../../../core/models/registry.js'
import { isModelCached } from '../../../utils/modelCache.js'
import * as opfs from '../../../utils/opfs.js'
import { confirmDialog } from '../../../composables/useConfirmations.js'
import ModalShell from '../ui/ModalShell.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import ShowAdvancedSettings from '../ui/ShowAdvancedSettings.vue'

// The preferences of this browser, by tab and group. A row whose default suits almost
// everyone (a custom satellite source, the near clipping distance, the worker count)
// is advanced: it shows under a tab's Advanced heading while the footer's Show advanced
// settings is on, the same switch as in the processing dialogs.
//
// `theme` is the stored preference ('system' | 'light' | 'dark'); `resolvedTheme`
// is what 'system' currently evaluates to, shown so the choice isn't opaque.
// `busy`: a run, an opening or a save is in flight (App's workInFlight), so the page
// must not reload, which an import or a reset of the settings does.
const props = defineProps({ theme: String, resolvedTheme: String, busy: { type: Boolean, default: false } })
const emit = defineEmits(['close', 'set-theme'])
const { t, tx, locale, setLanguage, languages } = useI18n()
const layout = provideStepLayout('settings')
const showAdvanced = computed(() => layout.showAdvanced.value)

const { gaps: browserGaps, warningEnabled, setEnabled: setBrowserWarningEnabled } = useBrowserWarning()
const { isMobile, warningEnabled: mobileWarningEnabled, setEnabled: setMobileWarningEnabled } = useMobileWarning()
const { glossaryTermsEnabled, setGlossaryTermsEnabled } = useGlossarySettings()
const {
  memBudgetGb,
  memBudgetAuto,
  setMemBudgetGb,
  resetMemBudgetAuto,
  deviceBudgetInfo,
  MAX_BUDGET_GB,
  useGpu,
  setUseGpu,
  workerCount,
  setWorkerCount,
  MAX_POOL_SIZE,
} = useComputeSettings()
const {
  motion,
  setMotion,
  confirmRemoveMark,
  setConfirmRemoveMark,
  keepAwake,
  setKeepAwake,
  notifySupported,
  notifyWhenDone,
  setNotifyWhenDone,
  showBugButton,
  setShowBugButton,
  openLastProject,
  setOpenLastProject,
} = useUiSettings()
const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
// Why the notification switch stayed off, when the browser said no.
const notifyRefusal = ref(null)
async function onNotifyToggle(event) {
  const wanted = event.target.checked
  const permission = await setNotifyWhenDone(wanted)
  event.target.checked = notifyWhenDone.value
  if (!wanted || notifyWhenDone.value) notifyRefusal.value = null
  else notifyRefusal.value = permission === 'denied' ? 'settings.notify.blocked' : 'settings.notify.notGranted'
}
const { gridZ, setGridZ, background, setBackground, nearClip, setNearClip, pointBudget, setPointBudget } =
  useViewerSettings()
const { basemap, setBasemap, satelliteUrl, satelliteAttribution, setSatelliteSource } = useMapSettings()
// Satellite source drafts: saved together on Apply, so a half-typed URL never
// reaches the map.
const satUrlDraft = ref(satelliteUrl.value)
const satAttributionDraft = ref(satelliteAttribution.value)
const satError = ref('')
const satDirty = computed(
  () =>
    satUrlDraft.value.trim() !== satelliteUrl.value || satAttributionDraft.value.trim() !== satelliteAttribution.value,
)
function applySatelliteSource() {
  satError.value = setSatelliteSource(satUrlDraft.value, satAttributionDraft.value)
}
function resetSatelliteSource() {
  satUrlDraft.value = ''
  satAttributionDraft.value = ''
  applySatelliteSource()
}

const themeOptions = ['system', 'light', 'dark'].map((id) => ({ id, label: msg(`settings.theme.${id}`) }))
const gridOptions = ['min', 'avg', 'max'].map((id) => ({ id, label: msg(`settings.gridZ.${id}`) }))
const BACKGROUNDS = ['theme', 'dark', 'light', 'black']

// The language list in three groups: translated, partly translated (a `preview`
// language; the rest shows in English) and planned (core/i18n PLANNED_LANGUAGES, shown
// but not selectable).
const fullLanguages = languages.filter((l) => !l.preview)
const partialLanguages = languages.filter((l) => l.preview)
const currentIsPartial = computed(() => partialLanguages.some((l) => l.id === locale.value))

// What the automatic memory limit was read from, in the user's terms.
const memorySource = { 'navigator.deviceMemory': 'device', 'performance.memory': 'heap' }[deviceBudgetInfo.source]

// Each tab's advanced rows, counted for the note shown while they are hidden.
const ADVANCED_COUNT = { general: 0, visualization: 2, compute: 1, storage: 0 }
const tabs = [
  { id: 'general', label: 'settings.tab.general' },
  { id: 'visualization', label: 'settings.tab.view' },
  { id: 'compute', label: 'settings.tab.compute' },
  { id: 'storage', label: 'settings.tab.storage' },
]
const activeTab = ref('general')

const storageUsage = ref(null)
const storageQuota = ref(null)
const storageDurable = ref(null)
const storageBusy = ref(false)
// The last storage action's outcome: a message, or null.
const storageMessage = ref(null)
const usagePercent = computed(() =>
  storageQuota.value > 0 ? Math.min(100, (storageUsage.value / storageQuota.value) * 100) : 0,
)
const errorText = (err) => String(err?.message ?? err)

async function refreshStorage() {
  try {
    const estimate = await opfs.getQuota()
    storageUsage.value = estimate.usage ?? 0
    storageQuota.value = estimate.quota ?? 0
    storageDurable.value = navigator.storage?.persisted ? await navigator.storage.persisted() : null
  } catch (err) {
    storageMessage.value = msg('settings.storage.readFailed', { error: errorText(err) })
  }
}

// Chromium decides this silently from site engagement (installed as an app,
// bookmarked, notifications allowed, repeat visits) and shows no prompt at all;
// only Firefox asks. So a denial is not an error and the message has to say what
// would actually change the verdict, rather than implying a dialog was dismissed.
async function requestDurableStorage() {
  storageBusy.value = true
  try {
    storageDurable.value = await opfs.requestDurable()
    storageMessage.value = msg(storageDurable.value ? 'settings.durable.granted' : 'settings.durable.declined')
  } catch (err) {
    storageMessage.value = msg('settings.durable.failed', { error: errorText(err) })
  } finally {
    storageBusy.value = false
  }
}

// The models in the cache, named from the registry, so a model added there is listed
// without touching this dialog. null while checking.
const cachedModels = ref(null)
async function refreshModels() {
  const found = []
  for (const [id, m] of Object.entries(MODELS)) if (await isModelCached(modelUrl(id))) found.push(m.label)
  cachedModels.value = found
}

async function clearModelCache() {
  if (
    !(await confirmDialog({
      title: t('settings.models.confirmTitle'),
      message: t('settings.models.confirmMessage'),
    }))
  )
    return
  storageBusy.value = true
  try {
    if (typeof caches !== 'undefined') await caches.delete(MODEL_CACHE_NAME)
    await Promise.all([refreshStorage(), refreshModels()])
    storageMessage.value = msg('settings.models.removed')
  } catch (err) {
    storageMessage.value = msg('settings.models.failed', { error: errorText(err) })
  } finally {
    storageBusy.value = false
  }
}

// Settings ▸ Storage ▸ Settings (composables/useSettingsTransfer.js). An import or a
// reset reloads the page, so neither runs while work is in flight.
const transfer = useSettingsTransfer()
const settingsFileInput = ref(null)
async function onExportSettings() {
  try {
    await transfer.exportSettings()
  } catch (err) {
    storageMessage.value = msg('settings.transfer.exportFailed', { error: errorText(err) })
  }
}
async function onImportFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const read = await transfer.readFile(file)
  if (read.error) {
    storageMessage.value = msg(read.error, { name: file.name })
    return
  }
  const ok = await confirmDialog({
    title: t('settings.transfer.importTitle'),
    message: t('settings.transfer.importMessage', { name: file.name }),
    confirmLabel: t('settings.transfer.importConfirm'),
  })
  if (!ok) return
  try {
    await transfer.applyImport(read, file.name)
    location.reload()
  } catch (err) {
    storageMessage.value = msg('settings.transfer.importFailed', { error: errorText(err) })
  }
}
async function onResetSettings() {
  const ok = await confirmDialog({
    title: t('settings.transfer.resetTitle'),
    message: t('settings.transfer.resetMessage'),
    confirmLabel: t('settings.transfer.resetConfirm'),
  })
  if (!ok) return
  try {
    await transfer.resetSettings()
    location.reload()
  } catch (err) {
    storageMessage.value = msg('settings.transfer.resetFailed', { error: errorText(err) })
  }
}

// Settings ▸ Storage ▸ Dialog presets: every dialog's named presets (dialogPresets.js),
// by dialog, named as its guide article, to rename or delete. Open dialogs follow.
const presetGroups = computed(() =>
  Object.entries(dialogPresets.value ?? {})
    .filter(([, list]) => list?.length)
    .map(([op, list]) => ({ op, title: getGuideDoc(op)?.title ?? op, list }))
    .sort((a, b) => a.title.localeCompare(b.title)),
)
const presetCount = computed(() => presetGroups.value.reduce((n, g) => n + g.list.length, 0))
// The preset being renamed: { op, from, name, error }, or null.
const renaming = ref(null)
function startPresetRename(op, from) {
  renaming.value = { op, from, name: from, error: null }
}
async function commitPresetRename() {
  const r = renaming.value
  if (!r) return
  const res = renamePreset(dialogPresets.value, r.op, r.from, r.name)
  if (res.error) {
    renaming.value = { ...r, error: res.error }
    return
  }
  renaming.value = null
  if (res.all !== dialogPresets.value) await writeDialogPresets(res.all)
}
async function deletePresetFromSettings(op, name) {
  const ok = await confirmDialog({
    title: t('settings.presets.deleteTitle'),
    message: t('settings.presets.deleteMessage', { name }),
    confirmLabel: t('settings.presets.delete'),
  })
  if (ok) await writeDialogPresets(withoutPreset(dialogPresets.value, op, name))
}

onMounted(() => {
  loadDialogPresets()
  refreshStorage()
  refreshModels()
})
</script>

<template>
  <!-- Flush: each tab's rows carry their own padding. -->
  <ModalShell :title="t('settings.title')" width="540px" flush @close="emit('close')">
    <template #tabs>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="modal-tab"
        role="tab"
        :class="{ active: activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ t(tab.label) }}
      </button>
    </template>

    <div class="settings-body">
      <template v-if="activeTab === 'general'">
        <h3 class="group-head">{{ t('settings.group.appearance') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.theme.label') }}</span>
            <span class="setting-desc">{{
              theme === 'system'
                ? t('settings.theme.followsSystem', { mode: resolvedTheme === 'light' ? 'light' : 'dark' })
                : t('settings.theme.fixed')
            }}</span>
          </div>
          <SegmentedControl
            :model-value="theme"
            :options="themeOptions"
            @update:model-value="emit('set-theme', $event)"
          />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.motion.label') }}</span>
            <span class="setting-desc">{{ t('settings.motion.desc') }}</span>
          </div>
          <select
            class="field-select"
            :aria-label="t('settings.motion.label')"
            :value="motion"
            @change="setMotion($event.target.value)"
          >
            <option value="system">{{ t('settings.motion.system') }}</option>
            <option value="reduce">{{ t('settings.motion.reduce') }}</option>
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label" for="settings-language">{{ t('settings.language.label') }}</label>
            <span class="setting-desc">{{
              t(currentIsPartial ? 'settings.language.descPartial' : 'settings.language.descFull')
            }}</span>
          </div>
          <select
            id="settings-language"
            class="field-select"
            :value="locale"
            @change="setLanguage($event.target.value)"
          >
            <optgroup :label="t('settings.language.full')">
              <option v-for="l in fullLanguages" :key="l.id" :value="l.id" :lang="l.id">{{ l.label }}</option>
            </optgroup>
            <optgroup v-if="partialLanguages.length" :label="t('settings.language.partial')">
              <option v-for="l in partialLanguages" :key="l.id" :value="l.id" :lang="l.id">{{ l.label }}</option>
            </optgroup>
            <optgroup v-if="PLANNED_LANGUAGES.length" :label="t('settings.language.planned')">
              <option
                v-for="l in PLANNED_LANGUAGES"
                :key="l.id"
                :value="l.id"
                :lang="l.id"
                disabled
                :title="t('settings.language.plannedReason')"
              >
                {{ l.label }}
              </option>
            </optgroup>
          </select>
        </div>

        <h3 class="group-head">{{ t('settings.group.startup') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.openLast.label') }}</span>
            <span class="setting-desc">{{ t('settings.openLast.desc') }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="openLastProject"
              :aria-label="t('settings.openLast.label')"
              @change="setOpenLastProject($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <h3 class="group-head">{{ t('settings.group.help') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.glossary.label') }}</span>
            <span class="setting-desc">{{ t('settings.glossary.desc') }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="glossaryTermsEnabled"
              :aria-label="t('settings.glossary.label')"
              @change="setGlossaryTermsEnabled($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <h3 class="group-head">{{ t('settings.group.editing') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.confirmMark.label') }}</span>
            <span class="setting-desc">{{ t('settings.confirmMark.desc') }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="confirmRemoveMark"
              :aria-label="t('settings.confirmMark.label')"
              @change="setConfirmRemoveMark($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <h3 class="group-head">{{ t('settings.group.notices') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.bugButton.label') }}</span>
            <span class="setting-desc">{{ t('settings.bugButton.desc') }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="showBugButton"
              :aria-label="t('settings.bugButton.label')"
              @change="setShowBugButton($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <div v-if="browserGaps.length" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.browserWarning.label') }}</span>
            <span class="setting-desc">{{ t('settings.browserWarning.desc') }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="warningEnabled"
              :aria-label="t('settings.browserWarning.label')"
              @change="setBrowserWarningEnabled($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <div v-if="isMobile" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.mobileWarning.label') }}</span>
            <span class="setting-desc">{{ t('settings.mobileWarning.desc') }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="mobileWarningEnabled"
              :aria-label="t('settings.mobileWarning.label')"
              @change="setMobileWarningEnabled($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>
      </template>

      <template v-else-if="activeTab === 'visualization'">
        <h3 class="group-head">{{ t('settings.group.map') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.basemap.label') }}</span>
            <span class="setting-desc">{{ t('settings.basemap.desc') }}</span>
          </div>
          <select
            class="field-select"
            :aria-label="t('settings.basemap.label')"
            :value="basemap"
            @change="setBasemap($event.target.value)"
          >
            <option v-for="b in BASEMAPS" :key="b.value" :value="b.value">{{ b.label }}</option>
          </select>
        </div>

        <h3 class="group-head">{{ t('settings.group.view3d') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.background.label') }}</span>
            <span class="setting-desc">{{ t('settings.background.desc') }}</span>
          </div>
          <select
            class="field-select"
            :aria-label="t('settings.background.label')"
            :value="background"
            @change="setBackground($event.target.value)"
          >
            <option v-for="b in BACKGROUNDS" :key="b" :value="b">{{ t(`settings.background.${b}`) }}</option>
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.gridZ.label') }}</span>
            <span class="setting-desc">{{ t('settings.gridZ.desc') }}</span>
          </div>
          <SegmentedControl :model-value="gridZ" :options="gridOptions" @update:model-value="setGridZ" />
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <!-- One span, so the label's flex gap does not split the sentence. -->
            <label class="setting-label" for="viewer-point-budget">
              <span>
                <I18nText k="settings.pointBudget.label">
                  <template #glossary="{ text }">
                    <GlossaryTerm id="level-of-detail">{{ text }}</GlossaryTerm>
                  </template>
                </I18nText>
              </span>
            </label>
            <span class="setting-desc">{{ t('settings.pointBudget.desc') }}</span>
          </div>
          <input
            id="viewer-point-budget"
            class="field-input"
            type="number"
            min="1"
            max="30"
            step="1"
            :value="pointBudget"
            @change="setPointBudget($event.target.value)"
          />
        </div>

        <h3 class="group-head">{{ t('settings.group.advanced') }}</h3>
        <template v-if="showAdvanced">
          <div class="setting-row setting-row-stacked">
            <div class="setting-info">
              <span class="setting-label">{{ t('settings.satellite.label') }}</span>
              <span class="setting-desc">
                <I18nText k="settings.satellite.desc">
                  <template #terms="{ text }">
                    <a :href="SATELLITE.terms" target="_blank" rel="noopener">{{ text }}</a>
                  </template>
                </I18nText>
              </span>
            </div>
            <input
              v-model="satUrlDraft"
              class="field-input wide"
              type="url"
              spellcheck="false"
              :placeholder="t('settings.satellite.urlPlaceholder')"
              :aria-label="t('settings.satellite.urlLabel')"
              @keydown.enter="applySatelliteSource"
            />
            <input
              v-model="satAttributionDraft"
              class="field-input wide"
              type="text"
              :placeholder="t('settings.satellite.attributionPlaceholder')"
              :aria-label="t('settings.satellite.attributionLabel')"
              :disabled="!satUrlDraft.trim()"
              :title="satUrlDraft.trim() ? null : t('settings.satellite.needsUrl')"
              @keydown.enter="applySatelliteSource"
            />
            <div class="setting-actions">
              <button
                class="btn"
                :disabled="!satDirty"
                :title="satDirty ? null : t('settings.satellite.noChanges')"
                @click="applySatelliteSource"
              >
                {{ t('settings.satellite.apply') }}
              </button>
              <button
                class="btn"
                :disabled="!satelliteUrl && !satUrlDraft"
                :title="!satelliteUrl && !satUrlDraft ? t('settings.satellite.alreadyEsri') : null"
                @click="resetSatelliteSource"
              >
                {{ t('settings.satellite.useEsri') }}
              </button>
              <span v-if="satError" class="field-error">{{ tx(satError) }}</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label" for="viewer-near-clip">{{ t('settings.nearClip.label') }}</label>
              <span class="setting-desc">{{ t('settings.nearClip.desc') }}</span>
            </div>
            <input
              id="viewer-near-clip"
              class="field-input"
              type="number"
              min="0"
              max="1000"
              step="0.001"
              :value="nearClip"
              @change="setNearClip($event.target.value)"
            />
          </div>
        </template>
        <p v-else class="advanced-note">{{ t('settings.advancedHidden', { n: ADVANCED_COUNT.visualization }) }}</p>
      </template>

      <template v-else-if="activeTab === 'compute'">
        <h3 class="group-head">{{ t('settings.group.resources') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label" for="settings-memory">{{ t('settings.memory.label') }}</label>
            <span class="setting-desc">
              {{ t('settings.memory.desc') }}
              {{
                memBudgetAuto
                  ? t('settings.memory.auto', {
                      source: memorySource ?? 'other',
                      gb: deviceBudgetInfo.deviceMemoryGB ?? 0,
                    })
                  : t('settings.memory.manual')
              }}
            </span>
          </div>
          <div class="setting-actions">
            <div class="num-input">
              <input
                id="settings-memory"
                class="field-input"
                type="number"
                min="0.25"
                :max="MAX_BUDGET_GB"
                step="0.5"
                :value="memBudgetGb"
                @change="setMemBudgetGb($event.target.value)"
              />
              <span class="num-unit">{{ t('settings.memory.unit') }}</span>
            </div>
            <button
              class="btn btn-compact"
              :disabled="memBudgetAuto"
              :title="memBudgetAuto ? t('settings.memory.autoActive') : t('settings.memory.autoTip')"
              @click="resetMemBudgetAuto"
            >
              {{ t('settings.memory.autoButton') }}
            </button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label"
              >{{ t('settings.gpu.label') }} <span class="badge">{{ t('settings.gpu.recommended') }}</span></span
            >
            <span class="setting-desc">{{ t('settings.gpu.desc') }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="useGpu"
              :aria-label="t('settings.gpu.label')"
              @change="setUseGpu($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <template v-if="wakeLockSupported || notifySupported">
          <h3 class="group-head">{{ t('settings.group.run') }}</h3>
          <div v-if="wakeLockSupported" class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ t('settings.keepAwake.label') }}</span>
              <span class="setting-desc">{{ t('settings.keepAwake.desc') }}</span>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                :checked="keepAwake"
                :aria-label="t('settings.keepAwake.label')"
                @change="setKeepAwake($event.target.checked)"
              />
              <span class="slider"></span>
            </label>
          </div>

          <div v-if="notifySupported" class="setting-row">
            <div class="setting-info">
              <span class="setting-label">{{ t('settings.notify.label') }}</span>
              <span class="setting-desc">{{ t(notifyRefusal ?? 'settings.notify.desc') }}</span>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                :checked="notifyWhenDone"
                :aria-label="t('settings.notify.label')"
                @change="onNotifyToggle"
              />
              <span class="slider"></span>
            </label>
          </div>
        </template>

        <h3 class="group-head">{{ t('settings.group.advanced') }}</h3>
        <div v-if="showAdvanced" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.workers.label') }}</span>
            <span class="setting-desc">{{ t('settings.workers.desc', { n: MAX_POOL_SIZE }) }}</span>
          </div>
          <select
            class="field-select"
            :aria-label="t('settings.workers.label')"
            :value="workerCount"
            @change="setWorkerCount($event.target.value)"
          >
            <option value="0">{{ t('settings.workers.auto', { n: MAX_POOL_SIZE }) }}</option>
            <option v-for="n in MAX_POOL_SIZE" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>
        <p v-else class="advanced-note">{{ t('settings.advancedHidden', { n: ADVANCED_COUNT.compute }) }}</p>
      </template>

      <template v-else-if="activeTab === 'storage'">
        <h3 class="group-head">{{ t('settings.group.data') }}</h3>
        <div class="setting-row setting-row-stacked">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.storage.label') }}</span>
            <span class="setting-desc">{{ t('settings.storage.desc') }}</span>
          </div>
          <div
            v-if="storageUsage != null && storageQuota"
            class="usage-bar"
            role="progressbar"
            :aria-valuenow="usagePercent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="usage-fill" :style="{ width: usagePercent + '%' }"></div>
          </div>
          <span v-if="storageUsage != null && storageQuota" class="setting-desc">{{
            t('settings.storage.used', { used: formatBytes(storageUsage), quota: formatBytes(storageQuota) })
          }}</span>
          <span v-else class="setting-desc">{{ t('settings.storage.unavailable') }}</span>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.durable.label') }}</span>
            <span class="setting-desc">{{ t('settings.durable.desc') }}</span>
          </div>
          <span v-if="storageDurable" class="status-ok">{{ t('settings.durable.protected') }}</span>
          <button
            v-else-if="storageDurable === false"
            class="btn"
            :disabled="storageBusy"
            :title="storageBusy ? t('settings.durable.busy') : null"
            @click="requestDurableStorage"
          >
            {{ t(storageBusy ? 'settings.durable.requesting' : 'settings.durable.request') }}
          </button>
          <span v-else class="readout">{{ t('settings.durable.unavailable') }}</span>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.models.label') }}</span>
            <span class="setting-desc">{{
              cachedModels == null
                ? t('settings.models.checking')
                : cachedModels.length
                  ? t('settings.models.some', { names: cachedModels })
                  : t('settings.models.none')
            }}</span>
          </div>
          <button
            class="btn"
            :disabled="storageBusy || !cachedModels?.length"
            :title="
              storageBusy ? t('settings.durable.busy') : !cachedModels?.length ? t('settings.models.nothing') : null
            "
            @click="clearModelCache"
          >
            {{ t('settings.models.clear') }}
          </button>
        </div>

        <h3 class="group-head">{{ t('settings.group.settings') }}</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.transfer.label') }}</span>
            <span class="setting-desc">{{ t('settings.transfer.desc') }}</span>
          </div>
          <div class="setting-actions">
            <button class="btn" @click="onExportSettings">{{ t('settings.transfer.export') }}</button>
            <button
              class="btn"
              :disabled="props.busy"
              :title="props.busy ? t('settings.transfer.busy') : null"
              @click="settingsFileInput?.click()"
            >
              {{ t('settings.transfer.import') }}
            </button>
            <input
              ref="settingsFileInput"
              type="file"
              accept=".json,application/json"
              hidden
              :aria-label="t('settings.transfer.import')"
              @change="onImportFile"
            />
          </div>
        </div>

        <div class="setting-row setting-row-stacked">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.presets.label') }}</span>
            <span class="setting-desc">{{
              presetCount ? t('settings.presets.desc', { n: presetCount }) : t('settings.presets.none')
            }}</span>
          </div>
          <div v-for="g in presetGroups" :key="g.op" class="preset-group">
            <div class="preset-dialog">{{ g.title }}</div>
            <div v-for="p in g.list" :key="p.name" class="preset-row">
              <template v-if="renaming?.op === g.op && renaming.from === p.name">
                <input
                  v-model="renaming.name"
                  class="field-input preset-name-input"
                  :aria-label="t('settings.presets.newName')"
                  @keydown.enter.prevent="commitPresetRename"
                  @keydown.esc.stop.prevent="renaming = null"
                />
                <button class="btn btn-compact" @click="commitPresetRename">{{ t('settings.presets.save') }}</button>
                <button class="btn btn-compact" @click="renaming = null">{{ t('common.cancel') }}</button>
                <span v-if="renaming.error" class="field-error">{{
                  t(`settings.presets.error.${renaming.error}`)
                }}</span>
              </template>
              <template v-else>
                <span class="preset-name">{{ p.name }}</span>
                <button class="btn btn-compact" @click="startPresetRename(g.op, p.name)">
                  {{ t('settings.presets.rename') }}
                </button>
                <button class="btn btn-compact" @click="deletePresetFromSettings(g.op, p.name)">
                  {{ t('settings.presets.delete') }}
                </button>
              </template>
            </div>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">{{ t('settings.transfer.resetLabel') }}</span>
            <span class="setting-desc">{{ t('settings.transfer.resetDesc') }}</span>
          </div>
          <button
            class="btn"
            :disabled="props.busy"
            :title="props.busy ? t('settings.transfer.busy') : null"
            @click="onResetSettings"
          >
            {{ t('settings.transfer.reset') }}
          </button>
        </div>

        <div v-if="storageMessage" class="status-message" aria-live="polite">{{ tx(storageMessage) }}</div>
      </template>
    </div>

    <template #footer>
      <ShowAdvancedSettings />
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.settings-body {
  padding: 8px 0;
  min-height: 240px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 16px;
}
.setting-row + .setting-row {
  border-top: 1px solid var(--panel-border);
}
/* A tab's settings in groups of a few, so it isn't one long list of switches. */
.group-head {
  margin: 0;
  padding: 14px 16px 4px;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-dim);
}
.group-head:first-child {
  padding-top: 6px;
}
.setting-row + .group-head {
  margin-top: 4px;
  border-top: 1px solid var(--panel-border);
}
/* Settings ▸ Storage ▸ Dialog presets: a dialog's name, then its presets. */
.preset-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.preset-dialog {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 10px;
  font-size: 12px;
}
.preset-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field-input.preset-name-input {
  flex: 1;
  width: auto;
  min-width: 0;
}
/* The note under Advanced while its rows are hidden: a note, not a link. */
.advanced-note {
  margin: 0;
  padding: 4px 16px 12px;
  font-size: 11px;
  color: var(--text-dim);
}
.setting-row-stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}
.setting-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.setting-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}
.setting-desc,
.status-message {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.45;
}
.status-message {
  padding: 11px 16px;
  color: var(--text);
  border-top: 1px solid var(--panel-border);
}
.badge {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 1px 5px;
}
.seg-row {
  flex-shrink: 0;
}
.field-select {
  flex-shrink: 0;
  max-width: 200px;
}
.field-input {
  flex-shrink: 0;
  width: 76px;
}
.field-input.wide {
  width: 100%;
  max-width: none;
}
.field-input:disabled {
  opacity: 0.5;
}
.setting-desc a {
  color: var(--accent);
}
.setting-desc :deep(code) {
  font-size: 10.5px;
}
.field-error {
  font-size: 11px;
  color: var(--danger);
}
/* The memory-limit row pairs a number input with its "Auto" reset; without this
   the two stack against the row's stretch alignment instead of sitting on one line. */
.setting-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.num-input {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.num-unit,
.readout {
  font-size: 12px;
  color: var(--text-dim);
}
.btn {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
  flex-shrink: 0;
}
.btn:hover:not(:disabled) {
  background: var(--hover-bg);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-compact {
  padding: 5px 10px;
}
.usage-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--hover-bg);
  overflow: hidden;
}
.usage-fill {
  height: 100%;
  background: var(--accent);
  min-width: 2px;
}
.status-ok {
  color: #3fae6a;
  font-size: 12px;
  font-weight: 600;
}
.switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  inset: 0;
  background: var(--panel-border);
  border-radius: 20px;
  transition: background 0.15s;
}
.slider::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s;
}
.switch input:checked + .slider {
  background: var(--accent);
}
.switch input:checked + .slider::before {
  transform: translateX(16px);
}
@media (max-width: 560px) {
  .setting-row:not(.setting-row-stacked) {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
