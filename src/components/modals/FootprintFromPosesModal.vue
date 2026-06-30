<script setup>
import { ref, computed } from 'vue'
import { focalPx } from '../../core/footprint.js'
import { useFootprintsStore } from '../../stores/useFootprintsStore.js'

const props = defineProps({
  poses:   { type: Array, default: () => [] },
  sensors: { type: Array, default: () => [] },
  images:  { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'run'])

const { resolveIntrinsics } = useFootprintsStore()

const settings = ref({
  useAgl: false,
  groundElev: 0,
  agl: 1000,
  assumeNadir: true,
  overwrite: true,
})

// Manual intrinsics override, for poses with no calibrated sensor (e.g. poses
// imported without their images). Prefilled from the first known sensor — its
// width/height are usually right even when its focal can't be resolved to px.
const seed = props.sensors[0] || null
const ov = ref({
  enabled: !props.sensors.some((s) => focalPx(s) != null),   // on when nothing is usable as-is
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

// Per-reason eligibility breakdown over all poses, mirroring the store. The
// "view too oblique" (diverging-ray) case can only be known at compute time, so
// it's excluded; everything else — including the camera-below-plane check — is
// predictable from the current settings.
const breakdown = computed(() => {
  const b = { ok: 0, noPose: 0, noElevation: 0, noAngles: 0, noSensor: 0, belowPlane: 0 }
  const s = settings.value
  for (const p of props.poses) {
    if (p.enabled === false) continue
    if (p.x == null || p.y == null) { b.noPose++; continue }
    if (p.z == null) { b.noElevation++; continue }
    if (!s.assumeNadir && (p.omega == null || p.phi == null || p.kappa == null)) { b.noAngles++; continue }
    if (!resolveIntrinsics(p, fallback.value)) { b.noSensor++; continue }
    const groundZ = s.useAgl ? p.z - s.agl : s.groundElev
    if (groundZ >= p.z) { b.belowPlane++; continue }
    b.ok++
  }
  return b
})

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
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Footprints from Poses">
      <div class="modal-header">
        <span class="modal-title">Footprints from Poses</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <p class="intro">
          Project each image's corners onto a horizontal ground plane using its
          camera position, orientation and sensor intrinsics.
        </p>

        <div class="field">
          <label class="field-label">Ground elevation</label>
          <div class="radio-row">
            <label class="radio"><input type="radio" :value="false" v-model="settings.useAgl" /> Absolute</label>
            <label class="radio"><input type="radio" :value="true"  v-model="settings.useAgl" /> Height above ground</label>
          </div>
          <div class="input-row" v-if="!settings.useAgl">
            <input v-model.number="settings.groundElev" type="number" step="any" class="field-input" />
            <span class="field-unit">m (project CRS)</span>
          </div>
          <div class="input-row" v-else>
            <input v-model.number="settings.agl" type="number" min="1" step="any" class="field-input" />
            <span class="field-unit">m below each camera</span>
          </div>
          <span class="field-hint">
            {{ settings.useAgl
              ? 'Ground plane is each camera’s Z minus this flying height.'
              : 'A single ground plane at this elevation, in the project vertical units.' }}
          </span>
        </div>

        <div class="section-sep"></div>

        <label class="check">
          <input type="checkbox" v-model="ov.enabled" />
          <span>Camera intrinsics (for poses with no calibrated sensor)</span>
        </label>
        <div v-if="ov.enabled" class="override">
          <div class="ov-row">
            <label class="ov-field">
              <span class="ov-label">Focal</span>
              <input v-model.number="ov.focal" type="number" min="0" step="any" class="field-input sm" />
            </label>
            <label class="ov-field">
              <span class="ov-label">Unit</span>
              <select v-model="ov.unit" class="field-input sm">
                <option value="px">pixels</option>
                <option value="mm">mm</option>
              </select>
            </label>
            <label v-if="ov.unit === 'mm'" class="ov-field">
              <span class="ov-label">Pixel size (mm)</span>
              <input v-model.number="ov.pixelSize" type="number" min="0" step="any" class="field-input sm" />
            </label>
          </div>
          <div class="ov-row">
            <label class="ov-field">
              <span class="ov-label">Image width (px)</span>
              <input v-model.number="ov.width" type="number" min="1" step="1" class="field-input sm" />
            </label>
            <label class="ov-field">
              <span class="ov-label">Image height (px)</span>
              <input v-model.number="ov.height" type="number" min="1" step="1" class="field-input sm" />
            </label>
          </div>
          <span v-if="ov.unit === 'mm' && !ov.pixelSize" class="field-hint warn">
            A mm focal needs a pixel size to convert to pixels.
          </span>
          <span v-else class="field-hint">
            Used only where an image's own sensor can't supply a pixel focal + dimensions.
          </span>
        </div>

        <div class="section-sep"></div>

        <label class="check">
          <input type="checkbox" v-model="settings.assumeNadir" />
          <span>Assume nadir for images without orientation angles</span>
        </label>
        <label class="check">
          <input type="checkbox" v-model="settings.overwrite" />
          <span>Replace previously computed footprints</span>
        </label>

        <div class="summary" :class="{ warn: breakdown.ok === 0 }">
          <div>{{ breakdown.ok }} of {{ total }} pose{{ total === 1 ? '' : 's' }} will produce a footprint</div>
          <ul v-if="reasonLines.length" class="reasons">
            <li v-for="r in reasonLines" :key="r.label">{{ r.n }} — {{ r.label }}</li>
          </ul>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="breakdown.ok === 0" @click="run">Compute Footprints</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 460px; max-width: 92vw; max-height: 90vh;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.intro { font-size: 12px; color: var(--text-dim); margin: 0; line-height: 1.45; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text); }
.field-hint { font-size: 11px; color: var(--text-dim); }
.field-hint.warn { color: #d89a3a; }
.section-sep { height: 1px; background: var(--panel-border); margin: 2px 0; }
.radio-row { display: flex; gap: 16px; }
.radio, .check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; }
.input-row { display: flex; align-items: center; gap: 6px; }
.field-input {
  width: 120px;
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px; padding: 4px 8px;
}
.field-input.sm { width: 92px; }
.field-input:focus { outline: none; border-color: var(--accent); }
.field-unit { font-size: 12px; color: var(--text-dim); }
.override { display: flex; flex-direction: column; gap: 8px; padding-left: 22px; }
.ov-row { display: flex; gap: 12px; flex-wrap: wrap; }
.ov-field { display: flex; flex-direction: column; gap: 4px; }
.ov-label { font-size: 11px; color: var(--text-dim); }
.summary { font-size: 12px; color: var(--text); margin-top: 2px; }
.summary.warn { color: #d89a3a; }
.reasons { margin: 4px 0 0; padding-left: 18px; color: var(--text-dim); }
.reasons li { font-size: 11px; }
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { opacity: 0.88; }
</style>
