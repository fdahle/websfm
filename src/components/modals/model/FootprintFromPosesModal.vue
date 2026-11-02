<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import WarnBox from '../ui/WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { focalPx } from '../../../core/footprint.js'
import { isGeographic, linearCrsUnit } from '../../../core/crs.js'
import { VERTICAL_DATUMS, datumLabel } from '../../../core/verticalDatum.js'
import { TERRAIN_DATUM } from '../../../core/terrainHeights.js'
import { useFootprintsStore } from '../../../stores/useFootprintsStore.js'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { FOOTPRINT_DEFAULTS } from '../../../core/defaults.user.js'
import { footprintsEffects } from '../../../core/stepEffects/footprintsFromPoses.js'

const props = defineProps({
  poses: { type: Array, default: () => [] },
  sensors: { type: Array, default: () => [] },
  images: { type: Array, default: () => [] },
  projectCrs: { type: String, default: null },
})

// A geographic (lat/lon) project CRS is fine — the store ray-casts in a local
// metric frame and maps the result back. Just note it so the units aren't a surprise.
const geographicCrs = computed(() => isGeographic(props.projectCrs))
// Heights are in the project's vertical unit, as the camera heights are (feet in a
// US-feet CRS; metres in a geographic one).
const heightUnit = computed(() => (props.projectCrs && !geographicCrs.value ? linearCrsUnit(props.projectCrs) : 'm'))
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
    if (p.x == null || p.y == null) {
      b.noPose++
      continue
    }
    if (p.z == null) {
      b.noElevation++
      continue
    }
    if (!s.assumeNadir && (p.omega == null || p.phi == null || p.kappa == null)) {
      b.noAngles++
      continue
    }
    if (!resolveIntrinsics(p, fallback.value)) {
      b.noSensor++
      continue
    }
    // The terrain under a camera is only known once it is read, at run time.
    const groundZ = s.ground === 'agl' ? p.z - s.agl : s.ground === 'absolute' ? s.groundElev : null
    if (groundZ != null && groundZ >= p.z) {
      b.belowPlane++
      continue
    }
    b.ok++
  }
  return b
})

const groundOptions = [
  { id: 'dem', label: 'Terrain model' },
  { id: 'absolute', label: 'Fixed elevation' },
  { id: 'agl', label: 'Height above ground' },
]

// What each step does with these poses (core/stepEffects/footprintsFromPoses.js).
const effects = computed(() =>
  footprintsEffects(settings.value, {
    demName: demOptions.value.find((o) => o.value === settings.value.demSource)?.label,
    demDatum: datumLabel(demDatum.value),
    poseDatum: settings.value.poseDatum === 'unknown' ? null : datumLabel(settings.value.poseDatum),
    unit: heightUnit.value,
    breakdown: breakdown.value,
    total: props.poses.filter((p) => p.enabled !== false).length,
    fallback: !!fallback.value,
  }),
)

function run() {
  emit('run', { ...settings.value, intrinsics: fallback.value })
}
</script>

<template>
  <ModalShell title="Footprints from Poses" @close="emit('close')">
    <p class="intro">
      Project each image's corners onto the ground using its camera position, orientation and sensor intrinsics. The
      footprints are drawn on the map (View ▸ Map ▸ Footprints shows and hides them); a new run replaces them.
    </p>
    <p v-if="geographicCrs" class="intro">
      Working CRS {{ projectCrs }} is geographic — footprints are computed in a local metric frame and stored back in
      lat/lon.
    </p>

    <SettingsStep step="1" title="Ground" :effect="effects.ground">
      <SettingsField>
        <template #label><FieldHelp op="footprints-from-poses" param="ground">Ground</FieldHelp></template>
        <SegmentedControl v-model="settings.ground" :options="groundOptions" />
      </SettingsField>
      <template v-if="settings.ground === 'dem'">
        <SettingsField label-for="fp-dem">
          <template #label><FieldHelp op="footprints-from-poses" param="demSource">Terrain model</FieldHelp></template>
          <select id="fp-dem" v-model="settings.demSource" class="field-select">
            <option v-for="o in demOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </SettingsField>
        <SettingsField label-for="fp-datum">
          <template #label><FieldHelp op="footprints-from-poses" param="poseDatum">Camera heights</FieldHelp></template>
          <select id="fp-datum" v-model="settings.poseDatum" class="field-select">
            <option v-for="d in VERTICAL_DATUMS" :key="d.id" :value="d.id">{{ d.label }}</option>
          </select>
        </SettingsField>
      </template>
      <SettingsField
        v-else-if="settings.ground === 'absolute'"
        label-for="fp-elev"
        :unit="`${heightUnit} (project CRS)`"
      >
        <template #label>
          <FieldHelp
            op="footprints-from-poses"
            param="groundElev"
            :value="settings.groundElev"
            :default-value="FOOTPRINT_DEFAULTS.groundElev"
            >Ground elevation</FieldHelp
          >
        </template>
        <input id="fp-elev" v-model.number="settings.groundElev" type="number" step="any" class="field-input" />
      </SettingsField>
      <SettingsField v-else label-for="fp-agl" :unit="`${heightUnit} below each camera`">
        <template #label>
          <FieldHelp
            op="footprints-from-poses"
            param="agl"
            :value="settings.agl"
            :default-value="FOOTPRINT_DEFAULTS.agl"
            >Flying height</FieldHelp
          >
        </template>
        <input id="fp-agl" v-model.number="settings.agl" type="number" min="1" step="any" class="field-input" />
      </SettingsField>
    </SettingsStep>

    <SettingsStep step="2" title="Cameras" :effect="effects.cameras">
      <SettingsField>
        <template #label>
          <FieldHelp
            op="footprints-from-poses"
            param="assumeNadir"
            :value="settings.assumeNadir"
            :default-value="FOOTPRINT_DEFAULTS.assumeNadir"
            >Assume nadir</FieldHelp
          >
        </template>
        <label class="checkbox-row"
          ><input v-model="settings.assumeNadir" type="checkbox" class="checkbox" /> For images without orientation
          angles</label
        >
      </SettingsField>
      <SettingsField>
        <template #label
          ><FieldHelp op="footprints-from-poses" param="intrinsics">Manual intrinsics</FieldHelp></template
        >
        <label class="checkbox-row"
          ><input v-model="ov.enabled" type="checkbox" class="checkbox" /> For poses with no calibrated sensor</label
        >
        <div v-if="ov.enabled" class="override">
          <div class="ov-row">
            <label class="ov-field"
              ><span class="ov-label">Focal</span>
              <input v-model.number="ov.focal" type="number" min="0" step="any" class="field-input sm"
            /></label>
            <label class="ov-field"
              ><span class="ov-label">Unit</span>
              <select v-model="ov.unit" class="field-select sm">
                <option value="px">pixels</option>
                <option value="mm">mm</option>
              </select></label
            >
            <label v-if="ov.unit === 'mm'" class="ov-field"
              ><span class="ov-label">Pixel size (mm)</span>
              <input v-model.number="ov.pixelSize" type="number" min="0" step="any" class="field-input sm"
            /></label>
          </div>
          <div class="ov-row">
            <label class="ov-field"
              ><span class="ov-label">Image width (px)</span>
              <input v-model.number="ov.width" type="number" min="1" step="1" class="field-input sm"
            /></label>
            <label class="ov-field"
              ><span class="ov-label">Image height (px)</span>
              <input v-model.number="ov.height" type="number" min="1" step="1" class="field-input sm"
            /></label>
          </div>
          <span v-if="ov.unit === 'mm' && !ov.pixelSize" class="field-hint warn">
            A mm focal needs a pixel size to convert to pixels.
          </span>
        </div>
      </SettingsField>
    </SettingsStep>

    <WarnBox v-if="breakdown.ok === 0">No pose can be placed yet: step 2 says why.</WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="breakdown.ok === 0" @click="run">Compute footprints</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.intro {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0;
  line-height: 1.45;
}
.field-hint.warn {
  color: #d89a3a;
}
.override {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 22px;
  margin-top: 6px;
}
.ov-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.ov-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ov-label {
  font-size: 11px;
  color: var(--text-dim);
}
.field-input.sm {
  width: 92px;
}
.field-select.sm {
  min-width: 92px;
}
</style>
