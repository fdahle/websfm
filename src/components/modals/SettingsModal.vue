<script setup>
import { computed, onMounted, ref } from 'vue'
import { useGlossarySettings } from '../../composables/useGlossarySettings.js'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { useViewerSettings } from '../../composables/useViewerSettings.js'
import { useUiSettings } from '../../composables/useUiSettings.js'
import { useBrowserWarning } from '../../composables/useBrowserWarning.js'
import { useMapSettings } from '../../composables/useMapSettings.js'
import { formatBytes } from '../../core/io/projectArchive.js'
import { MODEL_CACHE_NAME } from '../../core/models/registry.js'
import * as opfs from '../../utils/opfs.js'

// `theme` is the stored preference ('system' | 'light' | 'dark'); `resolvedTheme`
// is what 'system' currently evaluates to, shown so the choice isn't opaque.
const props = defineProps({ theme: String, resolvedTheme: String })
const emit = defineEmits(['close', 'set-theme'])

const { isChromium, warningEnabled, setEnabled: setBrowserWarningEnabled } = useBrowserWarning()
const { glossaryTermsEnabled, setGlossaryTermsEnabled } = useGlossarySettings()
const {
  memBudgetGb, memBudgetAuto, setMemBudgetGb, resetMemBudgetAuto, deviceBudgetInfo,
  useGpu, setUseGpu, workerCount, setWorkerCount, MAX_POOL_SIZE,
} = useComputeSettings()
const { advancedSettingsExpanded, setAdvancedSettingsExpanded, uiScale, setUiScale, motion, setMotion } = useUiSettings()
const { gridZ, setGridZ, background, setBackground } = useViewerSettings()
const { basemap, setBasemap } = useMapSettings()

const themeDesc = computed(() => (props.theme === 'system'
  ? `Following your operating system — currently ${props.resolvedTheme === 'light' ? 'light' : 'dark'}.`
  : 'Appearance used throughout the application.'))

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
const usagePercent = computed(() => storageQuota.value > 0
  ? Math.min(100, (storageUsage.value / storageQuota.value) * 100)
  : 0)

async function refreshStorage() {
  storageMessage.value = ''
  try {
    const estimate = await opfs.getQuota()
    storageUsage.value = estimate.usage ?? 0
    storageQuota.value = estimate.quota ?? 0
    storageDurable.value = navigator.storage?.persisted
      ? await navigator.storage.persisted()
      : null
  } catch (err) {
    storageMessage.value = `Storage information is unavailable: ${err?.message ?? err}`
  }
}

async function requestDurableStorage() {
  storageBusy.value = true
  try {
    storageDurable.value = await opfs.requestDurable()
    storageMessage.value = storageDurable.value
      ? 'Persistent storage enabled.'
      : 'The browser did not grant persistent storage. Projects still save normally, but may be evicted if space is critically low.'
  } catch (err) {
    storageMessage.value = `Could not request persistent storage: ${err?.message ?? err}`
  } finally {
    storageBusy.value = false
  }
}

async function clearModelCache() {
  if (!window.confirm('Remove downloaded AI models? They will be downloaded again when needed. Projects are not affected.')) return
  storageBusy.value = true
  try {
    const removed = typeof caches !== 'undefined' && await caches.delete(MODEL_CACHE_NAME)
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
  <div class="modal-overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="modal-header">
        <span class="modal-title">Settings</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="tab-bar" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab"
          role="tab"
          :class="{ active: activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >{{ tab.label }}</button>
      </div>

      <div class="modal-body">
        <template v-if="activeTab === 'general'">
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
              <span class="setting-label">Interface size</span>
              <span class="setting-desc">Scale the main workspace controls and panels.</span>
            </div>
            <div class="seg-toggle compact">
              <button :class="{ active: uiScale === 0.9 }" @click="setUiScale(0.9)">90%</button>
              <button :class="{ active: uiScale === 1 }" @click="setUiScale(1)">100%</button>
              <button :class="{ active: uiScale === 1.1 }" @click="setUiScale(1.1)">110%</button>
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

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Glossary terms</span>
              <span class="setting-desc">Highlight explained keywords; hover for a definition and a link to the full entry.</span>
            </div>
            <label class="switch">
              <input type="checkbox" :checked="glossaryTermsEnabled" @change="setGlossaryTermsEnabled($event.target.checked)">
              <span class="slider"></span>
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Expand advanced settings</span>
              <span class="setting-desc">Open processing dialogs with their advanced controls visible.</span>
            </div>
            <label class="switch">
              <input type="checkbox" :checked="advancedSettingsExpanded" @change="setAdvancedSettingsExpanded($event.target.checked)">
              <span class="slider"></span>
            </label>
          </div>

          <div v-if="!isChromium" class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Warn on unsupported browser</span>
              <span class="setting-desc">Remind me when browser limitations can affect compute or file access.</span>
            </div>
            <label class="switch">
              <input type="checkbox" :checked="warningEnabled" @change="setBrowserWarningEnabled($event.target.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </template>

        <template v-else-if="activeTab === 'visualization'">
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Map base layer</span>
              <span class="setting-desc">Automatic uses OpenStreetMap normally and the matching NASA layer for polar coordinate systems.</span>
            </div>
            <select class="select" :value="basemap" @change="setBasemap($event.target.value)">
              <option value="auto">Automatic</option>
              <option value="streets">Street map</option>
              <option value="none">None (grid only)</option>
            </select>
          </div>

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
              <span class="setting-desc">Place the reference grid at the bottom, centre, or top of the loaded point cloud.</span>
            </div>
            <div class="seg-toggle compact">
              <button :class="{ active: gridZ === 'min' }" @click="setGridZ('min')">Bottom</button>
              <button :class="{ active: gridZ === 'avg' }" @click="setGridZ('avg')">Middle</button>
              <button :class="{ active: gridZ === 'max' }" @click="setGridZ('max')">Top</button>
            </div>
          </div>

        </template>

        <template v-else-if="activeTab === 'compute'">
          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Memory safety limit</span>
              <span class="setting-desc">
                Dense runs stop before starting when estimated peak memory exceeds this amount.
                {{ memBudgetAuto ? `Automatically derived from ${deviceBudgetInfo.source}.` : 'Manually overridden.' }}
              </span>
            </div>
            <div class="setting-actions">
              <div class="num-input">
                <input type="number" min="0.25" step="0.5" :value="memBudgetGb" @change="setMemBudgetGb($event.target.value)">
                <span class="num-unit">GB</span>
              </div>
              <button v-if="!memBudgetAuto" class="btn" title="Use the detected device budget" @click="resetMemBudgetAuto">Auto</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Compute workers</span>
              <span class="setting-desc">Limit parallel CPU tasks to reduce memory pressure. Automatic uses up to {{ MAX_POOL_SIZE }} workers on this device.</span>
            </div>
            <select class="select" :value="workerCount" @change="setWorkerCount($event.target.value)">
              <option value="0">Automatic ({{ MAX_POOL_SIZE }})</option>
              <option v-for="n in MAX_POOL_SIZE" :key="n" :value="n">{{ n }}</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Use GPU <span class="badge">Experimental</span></span>
              <span class="setting-desc">Use WebGPU for supported matching and dense operations; unsupported operations fall back to CPU.</span>
            </div>
            <label class="switch">
              <input type="checkbox" :checked="useGpu" @change="setUseGpu($event.target.checked)">
              <span class="slider"></span>
            </label>
          </div>

        </template>

        <template v-else-if="activeTab === 'storage'">
          <div class="setting-row setting-row-stacked">
            <div class="setting-info">
              <span class="setting-label">Browser storage</span>
              <span class="setting-desc">Includes browser-backed projects, derived files, downloaded AI models, and other data stored for this site.</span>
            </div>
            <div v-if="storageUsage != null && storageQuota" class="usage-bar" role="progressbar" :aria-valuenow="usagePercent" aria-valuemin="0" aria-valuemax="100">
              <div class="usage-fill" :style="{ width: usagePercent + '%' }"></div>
            </div>
            <span v-if="storageUsage != null && storageQuota" class="setting-desc">{{ formatBytes(storageUsage) }} used of {{ formatBytes(storageQuota) }} available to this site</span>
            <span v-else class="setting-desc">Storage usage is unavailable in this browser.</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Storage protection</span>
              <span class="setting-desc">Persistent storage makes the browser less likely to evict local projects when disk space is low.</span>
            </div>
            <span v-if="storageDurable" class="status-ok">Protected</span>
            <button v-else-if="storageDurable === false" class="btn" :disabled="storageBusy" @click="requestDurableStorage">Request</button>
            <span v-else class="readout">Unavailable</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Downloaded AI models</span>
              <span class="setting-desc">Remove reusable SuperPoint, LightGlue, and Smart Select weights. They download again only when needed.</span>
            </div>
            <button class="btn" :disabled="storageBusy" @click="clearModelCache">Clear models</button>
          </div>

          <div v-if="storageMessage" class="status-message" aria-live="polite">{{ storageMessage }}</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 200; }
.modal { background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px; width: 540px; max-width: 92vw; max-height: 86vh; overflow: auto; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--panel-border); }
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-close { background: none; border: 0; color: var(--text-dim); font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px; }
.modal-close:hover { background: var(--hover-bg); color: var(--text); }
.tab-bar { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--panel-border); }
.tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--text-dim); font: inherit; font-size: 13px; padding: 10px 12px; margin-bottom: -1px; cursor: pointer; }
.tab:hover:not(.active) { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }
.modal-body { padding: 8px 0; min-height: 240px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 16px; }
.setting-row + .setting-row { border-top: 1px solid var(--panel-border); }
.setting-row-stacked { flex-direction: column; align-items: stretch; gap: 10px; }
.setting-info { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.setting-label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); }
.setting-desc, .status-message { font-size: 11px; color: var(--text-dim); line-height: 1.45; }
.status-message { padding: 11px 16px; }
.status-message { color: var(--text); border-top: 1px solid var(--panel-border); }
.badge { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); border: 1px solid var(--panel-border); border-radius: 4px; padding: 1px 5px; }
.seg-toggle { display: flex; border: 1px solid var(--panel-border); border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.seg-toggle button { background: none; border: 0; color: var(--text-dim); font: inherit; font-size: 12px; padding: 5px 16px; cursor: pointer; }
.seg-toggle.compact button { padding-inline: 9px; }
.seg-toggle button:hover:not(.active) { background: var(--hover-bg); color: var(--text); }
.seg-toggle button.active { background: var(--accent); color: #fff; }
.select, .num-input input { background: var(--input-bg, var(--panel)); border: 1px solid var(--panel-border); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 5px 8px; }
.select { max-width: 165px; }
.num-input { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.num-input input { width: 76px; }
.num-unit, .readout { font-size: 12px; color: var(--text-dim); }
.btn { background: none; border: 1px solid var(--panel-border); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 5px 12px; cursor: pointer; flex-shrink: 0; }
.btn:hover:not(:disabled) { background: var(--hover-bg); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.usage-bar { height: 8px; border-radius: 4px; background: var(--hover-bg); overflow: hidden; }
.usage-fill { height: 100%; background: var(--accent); min-width: 2px; }
.status-ok { color: #3fae6a; font-size: 12px; font-weight: 600; }
.switch { position: relative; display: inline-block; width: 36px; height: 20px; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; inset: 0; background: var(--panel-border); border-radius: 20px; transition: background .15s; }
.slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform .15s; }
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(16px); }
@media (max-width: 560px) {
  .setting-row:not(.setting-row-stacked) { align-items: flex-start; flex-direction: column; }
  .tab { padding-inline: 8px; }
}
</style>
