<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import WarnBox from '../ui/WarnBox.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { focalPx } from '../../../core/footprint.js'
import { isGeographic } from '../../../core/crs.js'
import { VERTICAL_DATUMS, datumLabel } from '../../../core/verticalDatum.js'
import { TERRAIN_DATUM } from '../../../core/terrainHeights.js'
import { useFootprintsStore } from '../../../stores/useFootprintsStore.js'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { FOOTPRINT_DEFAULTS } from '../../../core/defaults.user.js'

const props = defineProps({
  poses:   { type: Array, default: () => [] },
  sensors: { type: Array, default: () => [] },
  images:  { type: Array, default: () => [] },
  projectCrs: { type: String, default: null },
})

// A geographic (lat/lon) project CRS is fine — the store ray-casts in a local
// metric frame and maps the result back. Just note it so the units aren't a surprise.
const geographicCrs = computed(() => isGeographic(props.projectCrs))
const emit = defineEmits(['close', 'run'])

const { resolveIntrinsics } = useFootprintsStore()

// Defaults live in core/defaults.user.js (single source of truth).
const settings = ref({ ...FOOTPRINT_DEFAULTS })

// Terrain models: the global terrain tiles, or any imported reference DEM.
const external = useExternalStore()
const demOptions = computed(() => [
  { value: 'terrain', label: 'Global terrain (online, ~30 m)', datum: TERRAIN_DATUM },
  ...external.demRasters.map((r) => ({ value: r.id, label: r.name, datum: r.verticalDatum || 'unknown' })),
])
const demDatum = computed(() => demOptions.value.find((o) => o.value === settings.value.demSource)?.datum ?? 'unknown')
const datumHint = computed(() => {
  const dem = datumLabel(demDatum.value), cams = settings.value.poseDatum
  if (cams === 'unknown') return `Taken to be the terrain model's datum (${dem}).`
  if (cams === demDatum.value) return 'Same datum as the terrain model.'
  return `The terrain model (${dem}) is converted to it where the two convert.`
})

// Manual intrinsics override, for poses with no calibrated sensor (e.g. poses
// imported without their images). Prefilled from the first known sensor.
const seed = props.sensors[0] || null
const ov = ref({
  // On only when no pose resolves as-is (same resolver the breakdown uses, so the
  // manual fallback doesn't default-on for EXIF-derivable focals).
  enabled: !props.poses.some((p) => resolveIntrinsics(p, null) != null),
  focal: seed?.focal ?? null,
  unit: seed?.focalUnit === 'px' ? 'px' : 'mm',
  pixelSize: seed?.pixelSize ?? null,
  width: seed?.width ?? null,
  height: seed?.height ?? null,
})

// The override resolved to a { focal(px), width, height } fallback, or null when
// disabled/incomplete (e.g. a mm focal with no pixel size).
const fallback = computed(() => {
  if (!ov.value.enabled) return null
  const f = focalPx({ focal: ov.value.focal, focalUnit: ov.value.unit, pixelSize: ov.value.pixelSize })
  if (!(f > 0) || !(ov.value.width > 0) || !(ov.value.height > 0)) return null
  return { focal: f, width: ov.value.width, height: ov.value.height }
})

// Per-reason eligibility breakdown over all poses, mirroring the store.
const breakdown = computed(() => {
  const b = { ok: 0, noPose: 0, noElevation: 0, noAngles: 0, noSensor: 0, belowPlane: 0 }
  const s = settings.value
  for (const p of props.poses) {
    if (p.enabled === false) continue
    if (p.x == null || p.y == null) { b.noPose++; continue }
    if (p.z == null) { b.noElevation++; continue }
    if (!s.assumeNadir && (p.omega == null || p.phi == null || p.kappa == null)) { b.noAngles++; continue }
    if (!resolveIntrinsics(p, fallback.value)) { b.noSensor++; continue }
    // The terrain under a camera is only known once it is read, at run time.
    const groundZ = s.ground === 'agl' ? p.z - s.agl : s.ground === 'absolute' ? s.groundElev : null
    if (groundZ != null && groundZ >= p.z) { b.belowPlane++; continue }
    b.ok++
  }
  return b
})

const GROUND_HINT = {
  dem: 'Each corner lands where its ray meets the terrain.',
  absolute: 'One horizontal plane at this elevation, in the project vertical units.',
  agl: 'A plane per image, this far below its camera.',
}
const groundHint = computed(() => GROUND_HINT[settings.value.ground])

const total = computed(() => props.poses.length)
const REASON_LABEL = {
  noPose: 'missing X/Y position',
  noElevation: 'missing elevation (Z)',
  noAngles: 'missing orientation angles',
  noSensor: 'no calibrated sensor or intrinsics',
  belowPlane: 'camera at/below the ground elevation',
}
const reasonLines = computed(() =>
  Object.entries(REASON_LABEL)
    .filter(([k]) => breakdown.value[k] > 0)
    .map(([k, label]) => ({ n: breakdown.value[k], label })),
)

function run() {
  emit('run', { ...settings.value, intrinsics: fallback.value })
}
</script>

<template>
  <ModalShell title="Footprints from Poses" @close="emit('close')">
    <p class="intro">
      Project each image's corners onto the ground using its camera position,
      orientation and sensor intrinsics.
    </p>

    <SettingsField :hint="groundHint">
      <template #label><FieldHelp op="footprints-from-poses" param="ground">Ground</FieldHelp></template>
      <div class="radio-row">
        <label class="radio"><input type="radio" value="dem" v-model="settings.ground" /> Terrain model</label>
        <label class="radio"><input type="radio" value="absolute" v-model="settings.ground" /> Fixed elevation</label>
        <label class="radio"><input type="radio" value="agl" v-model="settings.ground" /> Height above ground</label>
      </div>
    </SettingsField>
    <template v-if="settings.ground === 'dem'">
      <SettingsField label-for="fp-dem">
        <template #label><FieldHelp op="footprints-from-poses" param="demSource">Terrain model</FieldHelp></template>
        <select id="fp-dem" v-model="settings.demSource" class="field-input field-select">
          <option v-for="o in demOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </SettingsField>
      <SettingsField label-for="fp-datum" :hint="datumHint">
        <template #label><FieldHelp op="footprints-from-poses" param="poseDatum">Camera heights</FieldHelp></template>
        <select id="fp-datum" v-model="settings.poseDatum" class="field-input field-select">
          <option v-for="d in VERTICAL_DATUMS" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
      </SettingsField>
    </template>
    <SettingsField v-else-if="settings.ground === 'absolute'" label-for="fp-elev" unit="m (project CRS)">
      <template #label>
        <FieldHelp op="footprints-from-poses" param="groundElev" :value="settings.groundElev"
          :default-value="FOOTPRINT_DEFAULTS.groundElev">Ground elevation</FieldHelp>
      </template>
      <input id="fp-elev" v-model.number="settings.groundElev" type="number" step="any" class="field-input" />
    </SettingsField>
    <SettingsField v-else label-for="fp-agl" unit="m below each camera">
      <template #label>
        <FieldHelp op="footprints-from-poses" param="agl" :value="settings.agl"
          :default-value="FOOTPRINT_DEFAULTS.agl">Flying height</FieldHelp>
      </template>
      <input id="fp-agl" v-model.number="settings.agl" type="number" min="1" step="any" class="field-input" />
    </SettingsField>

    <SettingsField>
      <template #label><GlossaryTerm id="camera-intrinsics">Camera intrinsics</GlossaryTerm> (for poses with no calibrated sensor)</template>
      <label class="checkbox-row"><input type="checkbox" v-model="ov.enabled" class="checkbox" /> Provide a manual fallback</label>
      <div v-if="ov.enabled" class="override">
        <div class="ov-row">
          <label class="ov-field"><span class="ov-label">Focal</span>
            <input v-model.number="ov.focal" type="number" min="0" step="any" class="field-input sm" /></label>
          <label class="ov-field"><span class="ov-label">Unit</span>
            <select v-model="ov.unit" class="field-input sm">
              <option value="px">pixels</option>
              <option value="mm">mm</option>
            </select></label>
          <label v-if="ov.unit === 'mm'" class="ov-field"><span class="ov-label">Pixel size (mm)</span>
            <input v-model.number="ov.pixelSize" type="number" min="0" step="any" class="field-input sm" /></label>
        </div>
        <div class="ov-row">
          <label class="ov-field"><span class="ov-label">Image width (px)</span>
            <input v-model.number="ov.width" type="number" min="1" step="1" class="field-input sm" /></label>
          <label class="ov-field"><span class="ov-label">Image height (px)</span>
            <input v-model.number="ov.height" type="number" min="1" step="1" class="field-input sm" /></label>
        </div>
        <span v-if="ov.unit === 'mm' && !ov.pixelSize" class="field-hint warn">
          A mm focal needs a pixel size to convert to pixels.
        </span>
        <span v-else class="field-hint">
          Used only where an image's own sensor can't supply a pixel focal + dimensions.
        </span>
      </div>
    </SettingsField>

    <SettingsField>
      <template #label>
        <FieldHelp op="footprints-from-poses" param="assumeNadir" :value="settings.assumeNadir"
          :default-value="FOOTPRINT_DEFAULTS.assumeNadir">Assume nadir</FieldHelp>
      </template>
      <label class="checkbox-row"><input type="checkbox" v-model="settings.assumeNadir" class="checkbox" /> For images without orientation angles</label>
    </SettingsField>
    <p class="intro">Runs into one “footprints” layer under Shapefiles, replacing any previous computed one.</p>

    <p v-if="geographicCrs" class="intro">
      Working CRS {{ projectCrs }} is geographic — footprints are computed in a local
      metric frame and stored back in lat/lon.
    </p>
    <div v-if="breakdown.ok > 0" class="summary">
      {{ breakdown.ok }} of {{ total }} pose{{ total === 1 ? '' : 's' }} will produce a footprint
      <ul v-if="reasonLines.length" class="reasons">
        <li v-for="r in reasonLines" :key="r.label">{{ r.n }} — {{ r.label }}</li>
      </ul>
    </div>
    <WarnBox v-else>
      No poses will produce a footprint.
      <ul v-if="reasonLines.length" class="reasons">
        <li v-for="r in reasonLines" :key="r.label">{{ r.n }} — {{ r.label }}</li>
      </ul>
    </WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="breakdown.ok === 0" @click="run">Compute Footprints</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.intro { font-size: 12px; color: var(--text-dim); margin: 0; line-height: 1.45; }
.radio-row { display: flex; gap: 16px; }
.radio { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; }
.field-hint.warn { color: #d89a3a; }
.override { display: flex; flex-direction: column; gap: 8px; padding-left: 22px; margin-top: 6px; }
.ov-row { display: flex; gap: 12px; flex-wrap: wrap; }
.ov-field { display: flex; flex-direction: column; gap: 4px; }
.ov-label { font-size: 11px; color: var(--text-dim); }
.field-input.sm { width: 92px; }
.summary { font-size: 12px; color: var(--text); }
.reasons { margin: 4px 0 0; padding-left: 18px; color: var(--text-dim); }
.reasons li { font-size: 11px; }
</style>
