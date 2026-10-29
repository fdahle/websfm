<script setup>
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { computed, onMounted, ref } from 'vue'
import { useGlossarySettings } from '../../../composables/useGlossarySettings.js'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'
import { useViewerSettings } from '../../../composables/useViewerSettings.js'
import { useUiSettings } from '../../../composables/useUiSettings.js'
import { useBrowserWarning } from '../../../composables/useBrowserWarning.js'
import { useMobileWarning } from '../../../composables/useMobileWarning.js'
import { useMapSettings } from '../../../composables/useMapSettings.js'
import { BASEMAPS, SATELLITE } from '../../../core/basemaps.js'
import { formatBytes } from '../../../core/io/projectArchive.js'
import { MODEL_CACHE_NAME } from '../../../core/models/registry.js'
import * as opfs from '../../../utils/opfs.js'
import { confirmDialog } from '../../../composables/useConfirmations.js'
import ModalShell from '../ui/ModalShell.vue'

// `theme` is the stored preference ('system' | 'light' | 'dark'); `resolvedTheme`
// is what 'system' currently evaluates to, shown so the choice isn't opaque.
const props = defineProps({ theme: String, resolvedTheme: String })
const emit = defineEmits(['close', 'set-theme'])

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
  POOL_BUDGET_GB,
  useGpu,
  setUseGpu,
  workerCount,
  setWorkerCount,
  MAX_POOL_SIZE,
} = useComputeSettings()
const {
  advancedSettingsExpanded,
  setAdvancedSettingsExpanded,
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
} = useUiSettings()
const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
// Why the notification switch stayed off, when the browser said no.
const notifyRefusal = ref('')
async function onNotifyToggle(event) {
  const wanted = event.target.checked
  const permission = await setNotifyWhenDone(wanted)
  event.target.checked = notifyWhenDone.value
  if (!wanted || notifyWhenDone.value) notifyRefusal.value = ''
  else if (permission === 'denied') {
    notifyRefusal.value =
      'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn this on.'
  } else
    notifyRefusal.value = 'The browser did not grant permission to notify. Turn this on again to be asked once more.'
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

const themeDesc = computed(() =>
  props.theme === 'system'
    ? `Following your operating system — currently ${props.resolvedTheme === 'light' ? 'light' : 'dark'}.`
    : 'Appearance used throughout the application.',
)

const tabs = [
  { id: 'general', label: 'General' },
  { id: 'visualization', label: 'Map & 3D' },
  { id: 'compute', label: 'Compute' },
  { id: 'storage', label: 'Storage' },
]
const activeTab = ref('general')

const storageUsage = ref(null)
const storageQuota = ref(null)
const storageDurable = ref(null)
const storageBusy = ref(false)
const storageMessage = ref('')
const usagePercent = computed(() =>
  storageQuota.value > 0 ? Math.min(100, (storageUsage.value / storageQuota.value) * 100) : 0,
)

async function refreshStorage() {
  storageMessage.value = ''
  try {
    const estimate = await opfs.getQuota()
    storageUsage.value = estimate.usage ?? 0
    storageQuota.value = estimate.quota ?? 0
    storageDurable.value = navigator.storage?.persisted ? await navigator.storage.persisted() : null
  } catch (err) {
    storageMessage.value = `Storage information is unavailable: ${err?.message ?? err}`
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
    storageMessage.value = storageDurable.value
      ? 'Persistent storage enabled.'
      : 'The browser declined for now — most browsers grant this automatically once the site is used regularly, bookmarked, or installed as an app, without asking. Projects still save normally, but may be evicted if disk space runs critically low. You can try again later.'
  } catch (err) {
    storageMessage.value = `Could not request persistent storage: ${err?.message ?? err}`
  } finally {
    storageBusy.value = false
  }
}

async function clearModelCache() {
  if (
    !(await confirmDialog({
      title: 'Remove downloaded models?',
      message: 'Remove downloaded AI models? They will be downloaded again when needed. Projects are not affected.',
    }))
  )
    return
  storageBusy.value = true
  try {
    const removed = typeof caches !== 'undefined' && (await caches.delete(MODEL_CACHE_NAME))
    await refreshStorage()
    storageMessage.value = removed ? 'Downloaded AI models removed.' : 'No downloaded AI models were stored.'
  } catch (err) {
    storageMessage.value = `Could not clear downloaded models: ${err?.message ?? err}`
  } finally {
    storageBusy.value = false
  }
}

onMounted(refreshStorage)
</script>

<template>
  <!-- Flush: the tab bar runs edge to edge; each tab's rows carry their own padding. -->
  <ModalShell title="Settings" width="540px" flush @close="emit('close')">
    <div class="tab-bar" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        role="tab"
        :class="{ active: activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="settings-body">
      <template v-if="activeTab === 'general'">
        <h3 class="group-head">Appearance</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Theme</span>
            <span class="setting-desc">{{ themeDesc }}</span>
          </div>
          <div class="seg-toggle compact">
            <button :class="{ active: theme === 'system' }" @click="emit('set-theme', 'system')">System</button>
            <button :class="{ active: theme === 'light' }" @click="emit('set-theme', 'light')">Light</button>
            <button :class="{ active: theme === 'dark' }" @click="emit('set-theme', 'dark')">Dark</button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Motion</span>
            <span class="setting-desc">Follow the operating system or minimize interface animation.</span>
          </div>
          <select class="select" :value="motion" @change="setMotion($event.target.value)">
            <option value="system">Follow system</option>
            <option value="reduce">Reduce motion</option>
          </select>
        </div>

        <h3 class="group-head">Help and dialogs</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Glossary terms</span>
            <span class="setting-desc"
              >Underline explained words and put a ? after settings with advice; hover for the explanation and a link to
              the full entry.</span
            >
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="glossaryTermsEnabled"
              @change="setGlossaryTermsEnabled($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Expand advanced settings</span>
            <span class="setting-desc">Open processing dialogs with their advanced controls visible.</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="advancedSettingsExpanded"
              @change="setAdvancedSettingsExpanded($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Confirm before removing a mark</span>
            <span class="setting-desc">Ask before deleting a single image mark of a control point or marker.</span>
          </div>
          <label class="switch">
            <input type="checkbox" :checked="confirmRemoveMark" @change="setConfirmRemoveMark($event.target.checked)" />
            <span class="slider"></span>
          </label>
        </div>

        <h3 v-if="wakeLockSupported || notifySupported" class="group-head">During a run</h3>
        <div v-if="wakeLockSupported" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Keep the screen on during a run</span>
            <span class="setting-desc"
              >Stop the display, and on most systems the computer, from going to sleep while a stage or workflow runs.
              Applies while the WebSfM tab is visible.</span
            >
          </div>
          <label class="switch">
            <input type="checkbox" :checked="keepAwake" @change="setKeepAwake($event.target.checked)" />
            <span class="slider"></span>
          </label>
        </div>

        <div v-if="notifySupported" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Notify when a run ends</span>
            <span class="setting-desc">{{
              notifyRefusal ||
              'A desktop notification when a run of 30 seconds or more ends, or a workflow needs you, while the WebSfM tab is in the background.'
            }}</span>
          </div>
          <label class="switch">
            <input type="checkbox" :checked="notifyWhenDone" @change="onNotifyToggle" />
            <span class="slider"></span>
          </label>
        </div>

        <h3 class="group-head">Notices</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Bug report button</span>
            <span class="setting-desc"
              >Show the round button at the bottom right that opens a new GitHub issue. Other ▸ About links there
              too.</span
            >
          </div>
          <label class="switch">
            <input type="checkbox" :checked="showBugButton" @change="setShowBugButton($event.target.checked)" />
            <span class="slider"></span>
          </label>
        </div>

        <div v-if="browserGaps.length" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Warn on unsupported browser</span>
            <span class="setting-desc">Remind me when browser limitations can affect compute or file access.</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="warningEnabled"
              @change="setBrowserWarningEnabled($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>

        <div v-if="isMobile" class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Warn on mobile devices</span>
            <span class="setting-desc"
              >Show the notice that WebSfM is a desktop application and mobile layout is unsupported.</span
            >
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="mobileWarningEnabled"
              @change="setMobileWarningEnabled($event.target.checked)"
            />
            <span class="slider"></span>
          </label>
        </div>
      </template>

      <template v-else-if="activeTab === 'visualization'">
        <h3 class="group-head">Map</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Map base layer</span>
            <span class="setting-desc"
              >Automatic uses OpenStreetMap normally and the matching NASA layer for polar coordinate systems. Satellite
              and Terrain are not available for polar systems.</span
            >
          </div>
          <select class="select" :value="basemap" @change="setBasemap($event.target.value)">
            <option v-for="b in BASEMAPS" :key="b.value" :value="b.value">{{ b.label }}</option>
          </select>
        </div>

        <div class="setting-row setting-row-stacked">
          <div class="setting-info">
            <span class="setting-label">Satellite imagery source</span>
            <span class="setting-desc">
              By default Satellite shows Esri World Imagery, which is provided under
              <a :href="SATELLITE.terms" target="_blank" rel="noopener">Esri's terms of use</a> — commercial use may
              need an ArcGIS account. To use a provider you hold a licence for, enter its XYZ tile URL with
              <code>{z}</code>, <code>{x}</code> and <code>{y}</code>
              (and your API key, if it needs one). It is stored only in this browser.
            </span>
          </div>
          <input
            v-model="satUrlDraft"
            class="text-input"
            type="url"
            spellcheck="false"
            placeholder="Esri World Imagery (default)"
            aria-label="Satellite tile URL"
            @keydown.enter="applySatelliteSource"
          />
          <input
            v-model="satAttributionDraft"
            class="text-input"
            type="text"
            placeholder="Attribution, e.g. © Provider"
            aria-label="Satellite attribution"
            :disabled="!satUrlDraft.trim()"
            @keydown.enter="applySatelliteSource"
          />
          <div class="setting-actions">
            <button class="btn" :disabled="!satDirty" @click="applySatelliteSource">Apply</button>
            <button class="btn" :disabled="!satelliteUrl && !satUrlDraft" @click="resetSatelliteSource">
              Use Esri
            </button>
            <span v-if="satError" class="field-error">{{ satError }}</span>
          </div>
        </div>

        <h3 class="group-head">3D view</h3>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">3D background</span>
            <span class="setting-desc">Choose a neutral canvas independently of the application theme.</span>
          </div>
          <select class="select" :value="background" @change="setBackground($event.target.value)">
            <option value="theme">Follow theme</option>
            <option value="dark">Dark grey</option>
            <option value="light">Light grey</option>
            <option value="black">Black</option>
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">3D ground-grid height</span>
            <span class="setting-desc"
              >Place the reference grid at the bottom, centre, or top of the loaded point cloud.</span
            >
          </div>
          <div class="seg-toggle compact">
            <button :class="{ active: gridZ === 'min' }" @click="setGridZ('min')">Bottom</button>
            <button :class="{ active: gridZ === 'avg' }" @click="setGridZ('avg')">Middle</button>
            <button :class="{ active: gridZ === 'max' }" @click="setGridZ('max')">Top</button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label" for="viewer-near-clip">3D near clipping distance</label>
            <span class="setting-desc"
              >0 adjusts automatically as you zoom. A smaller manual distance keeps nearby points visible. Values use
              scene units.</span
            >
          </div>
          <div class="num-input">
            <input
              id="viewer-near-clip"
              type="number"
              min="0"
              max="1000"
              step="0.001"
              :value="nearClip"
              @change="setNearClip($event.target.value)"
            />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label" for="viewer-point-budget"
              >3D <GlossaryTerm id="level-of-detail">point budget</GlossaryTerm> (million points)</label
            >
            <span class="setting-desc"
              >Clouds of 4 million points or more are drawn level of detail: at most this many points at once, in most
              detail near the view's centre of attention. Lower it if orbiting stutters.</span
            >
          </div>
          <div class="num-input">
            <input
              id="viewer-point-budget"
              type="number"
              min="1"
              max="30"
              step="1"
              :value="pointBudget"
              @change="setPointBudget($event.target.value)"
            />
          </div>
        </div>
      </template>

      <template v-else-if="activeTab === 'compute'">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Memory safety limit</span>
            <span class="setting-desc">
              Dense runs stop before starting when estimated peak memory exceeds this amount. Runs use at most
              {{ POOL_BUDGET_GB }} GB of it in buffers (a Chrome tab holds 16 GB of them, shared by the page and all its
              workers); fusion keeps its largest arrays in WebAssembly memory and may use the rest.
              {{ memBudgetAuto ? `Automatically derived from ${deviceBudgetInfo.source}.` : 'Manually overridden.' }}
            </span>
          </div>
          <div class="setting-actions">
            <div class="num-input">
              <input
                type="number"
                min="0.25"
                :max="MAX_BUDGET_GB"
                step="0.5"
                :value="memBudgetGb"
                @change="setMemBudgetGb($event.target.value)"
              />
              <span class="num-unit">GB</span>
            </div>
            <button
              class="btn btn-compact"
              :disabled="memBudgetAuto"
              :title="memBudgetAuto ? 'Already using the detected device budget' : 'Use the detected device budget'"
              @click="resetMemBudgetAuto"
            >
              Auto
            </button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Compute workers</span>
            <span class="setting-desc"
              >Limit parallel CPU tasks to reduce memory pressure. Automatic uses up to {{ MAX_POOL_SIZE }} workers on
              this device.</span
            >
          </div>
          <select class="select" :value="workerCount" @change="setWorkerCount($event.target.value)">
            <option value="0">Automatic ({{ MAX_POOL_SIZE }})</option>
            <option v-for="n in MAX_POOL_SIZE" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Use GPU <span class="badge">Recommended</span></span>
            <span class="setting-desc"
              >Automatically enabled when this browser offers WebGPU. Supported matching and dense operations use it;
              unavailable operations fall back to CPU.</span
            >
          </div>
          <label class="switch">
            <input type="checkbox" :checked="useGpu" @change="setUseGpu($event.target.checked)" />
            <span class="slider"></span>
          </label>
        </div>
      </template>

      <template v-else-if="activeTab === 'storage'">
        <div class="setting-row setting-row-stacked">
          <div class="setting-info">
            <span class="setting-label">Browser storage</span>
            <span class="setting-desc"
              >Includes browser-backed projects, derived files, downloaded AI models, and other data stored for this
              site.</span
            >
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
          <span v-if="storageUsage != null && storageQuota" class="setting-desc"
            >{{ formatBytes(storageUsage) }} used of {{ formatBytes(storageQuota) }} available to this site</span
          >
          <span v-else class="setting-desc">Storage usage is unavailable in this browser.</span>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Storage protection</span>
            <span class="setting-desc"
              >Persistent storage makes the browser less likely to evict local projects when disk space is low. The
              browser decides this itself — usually without asking — based on how often the site is used.</span
            >
          </div>
          <span v-if="storageDurable" class="status-ok">Protected</span>
          <button
            v-else-if="storageDurable === false"
            class="btn"
            :disabled="storageBusy"
            @click="requestDurableStorage"
          >
            {{ storageBusy ? 'Requesting…' : 'Request' }}
          </button>
          <span v-else class="readout">Unavailable</span>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">Downloaded AI models</span>
            <span class="setting-desc"
              >Remove reusable SuperPoint, DISK, ALIKED, LightGlue, and Smart Select weights. They download again only
              when needed.</span
            >
          </div>
          <button class="btn" :disabled="storageBusy" @click="clearModelCache">Clear models</button>
        </div>

        <div v-if="storageMessage" class="status-message" aria-live="polite">{{ storageMessage }}</div>
      </template>
    </div>
  </ModalShell>
</template>

<style scoped>
.tab-bar {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--panel-border);
}
.tab {
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  padding: 10px 12px;
  margin-bottom: -1px;
  cursor: pointer;
}
.tab:hover:not(.active) {
  color: var(--text);
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
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
}
.status-message {
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
.seg-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}
.seg-toggle button {
  background: none;
  border: 0;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 5px 16px;
  cursor: pointer;
}
.seg-toggle.compact button {
  padding-inline: 9px;
}
.seg-toggle button:hover:not(.active) {
  background: var(--hover-bg);
  color: var(--text);
}
.seg-toggle button.active {
  background: var(--accent);
  color: #fff;
}
.select,
.num-input input {
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
}
.select {
  max-width: 165px;
}
.text-input {
  background: var(--input-bg, var(--panel));
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
  min-width: 0;
}
.text-input:disabled {
  opacity: 0.5;
}
.setting-desc a {
  color: var(--accent);
}
.setting-desc code {
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
.num-input input {
  width: 76px;
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
  .tab {
    padding-inline: 8px;
  }
}
</style>
