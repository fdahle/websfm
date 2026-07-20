<script setup>
import { ref, computed } from 'vue'

// Confirm the DEM-vs-orthophoto classification of an already-imported reference
// raster (the parseRaster worker op ran before this opens, and the raster is
// already in the store — this modal *corrects* it rather than gating it).
//
// It opens when the sniff was LOW confidence (a 1-band int16/uint16 raster
// resolved by histogram alone, or by filename alone) — a high-confidence sniff
// (float samples, a nodata tag, ≥3 bands, 1-band uint8) imports silently and
// just logs its reasons, which is safe because the kind stays editable on the
// Reference Data row afterwards. It also opens unconditionally for the sidebar's
// manual "Convert to reference data…" action, where the auto-routing already got
// this file wrong once and its confidence is not worth trusting.
//
// `data` is { raster: RasterMeta, fileName } from useModalsStore.
const props = defineProps({ data: { type: Object, required: true } })
const emit = defineEmits(['close', 'set-kind', 'set-vertical', 'import-as-image'])

const raster = computed(() => props.data.raster)
const kind = ref(raster.value.kind)

// Vertical datum matters enough to ask for here rather than bury in a row menu:
// ellipsoid-vs-geoid is tens of metres in Antarctica, systematic and slowly
// varying — exactly the error shape a similarity fit cannot absorb but will
// silently soak into a scale/tilt error.
const verticalDatum = ref(raster.value.verticalDatum || 'unknown')
const verticalAccuracy = ref(raster.value.verticalAccuracy ?? null)

const reasons = computed(() => raster.value.classification?.reasons || [])
const isDem = computed(() => kind.value === 'dem')

function confirm() {
  if (kind.value !== raster.value.kind) emit('set-kind', { id: raster.value.id, kind: kind.value })
  if (isDem.value) {
    emit('set-vertical', {
      id: raster.value.id,
      verticalDatum: verticalDatum.value,
      verticalAccuracy: Number.isFinite(verticalAccuracy.value) ? verticalAccuracy.value : null,
    })
  }
  emit('close')
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Import Reference Raster">
      <div class="modal-header">
        <span class="modal-title">Reference raster — confirm type</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="filename">{{ data.fileName }}</div>
        <div class="stats">
          <span>{{ raster.width.toLocaleString() }} × {{ raster.height.toLocaleString() }} px</span>
          <span>{{ raster.bands }} band{{ raster.bands === 1 ? '' : 's' }}</span>
          <span>{{ raster.dtype }}</span>
          <span>{{ raster.crs || 'no CRS' }}</span>
        </div>

        <img v-if="raster.previewDataUrl" :src="raster.previewDataUrl" class="preview" alt="" />

        <!-- The reasons are the point of this modal: a guess you can't audit is
             a guess you have to reverse-engineer later. -->
        <div class="why">
          <div class="why-hd">
            Guessed <strong>{{ raster.kind === 'dem' ? 'DEM' : 'orthophoto' }}</strong>,
            {{ raster.classification?.confidence ?? 'low' }} confidence:
          </div>
          <ul>
            <li v-for="(r, i) in reasons" :key="i">{{ r }}</li>
          </ul>
        </div>

        <div class="field">
          <label class="field-label">This raster is</label>
          <div class="seg">
            <button class="seg-btn" :class="{ active: kind === 'dem' }" @click="kind = 'dem'">
              DEM (elevation)
            </button>
            <button class="seg-btn" :class="{ active: kind === 'ortho' }" @click="kind = 'ortho'">
              Orthophoto (imagery)
            </button>
          </div>
        </div>

        <template v-if="isDem">
          <div class="field">
            <label class="field-label" for="vdatum">Vertical datum</label>
            <select id="vdatum" v-model="verticalDatum" class="field-input">
              <option value="ellipsoidal">Ellipsoidal (WGS84) — REMA, most photogrammetric DSMs</option>
              <option value="geoid:EGM2008">Geoid EGM2008</option>
              <option value="geoid:EGM96">Geoid EGM96</option>
              <option value="unknown">Unknown</option>
            </select>
            <span v-if="verticalDatum === 'unknown'" class="field-hint warn">
              ⚠ Ellipsoid vs geoid differs by tens of metres in polar regions. Elevations taken
              from this raster will carry a standing warning.
            </span>
          </div>

          <div class="field">
            <label class="field-label" for="vacc">Vertical accuracy (σ, metres)</label>
            <input
              id="vacc"
              v-model.number="verticalAccuracy"
              type="number"
              min="0"
              step="any"
              placeholder="e.g. 1 for REMA, 4 for COP30"
              class="field-input short"
            />
            <span class="field-hint">
              Used as <code>accuracyZ</code> when a GCP's Z is filled from this DEM. Leave blank
              and the fill action will refuse rather than let a GCP claim survey-grade Z.
            </span>
          </div>
        </template>

        <!-- The escape hatch the routing fork promises: a georeferenced source
             photo is unusual but not impossible. -->
        <button class="link-btn" @click="emit('import-as-image', { id: raster.id })">
          This is a source photo, not reference data — import it as an image instead
        </button>
      </div>

      <div class="modal-footer">
        <button class="btn btn-primary" @click="confirm">Done</button>
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
  width: 460px; max-width: 90vw; max-height: 88vh;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px; border-bottom: 1px solid var(--panel-border);
}
.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }
.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}
.filename { font-size: 13px; font-weight: 600; color: var(--text); word-break: break-all; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--text-dim); }
.preview {
  max-width: 100%; max-height: 180px; align-self: center;
  border: 1px solid var(--panel-border); border-radius: 4px;
  image-rendering: pixelated; background: var(--bg);
}
.why {
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; padding: 8px 10px; font-size: 11px; color: var(--text-dim);
}
.why-hd { margin-bottom: 4px; color: var(--text); }
.why ul { margin: 0; padding-left: 16px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text); }
.field-hint { font-size: 11px; color: var(--text-dim); }
.field-hint.warn { color: var(--warn, #d9a441); }
.field-input {
  background: var(--bg); border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px; padding: 4px 8px;
}
.field-input.short { width: 140px; }
.field-input:focus { outline: none; border-color: var(--accent); }
.seg { display: flex; gap: 0; }
.seg-btn {
  flex: 1; background: var(--bg); border: 1px solid var(--panel-border);
  color: var(--text-dim); font: inherit; font-size: 12px; padding: 6px 10px; cursor: pointer;
}
.seg-btn:first-child { border-radius: 5px 0 0 5px; }
.seg-btn:last-child { border-radius: 0 5px 5px 0; border-left: none; }
.seg-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.link-btn {
  background: none; border: none; color: var(--accent);
  font: inherit; font-size: 11px; text-align: left; padding: 0; cursor: pointer;
}
.link-btn:hover { text-decoration: underline; }
.btn {
  background: none; border: 1px solid var(--panel-border);
  border-radius: 5px; color: var(--text); font: inherit; font-size: 13px;
  padding: 5px 14px; cursor: pointer;
}
.btn:hover { background: var(--hover-bg); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { opacity: 0.88; }
</style>
