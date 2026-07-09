<script setup>
import { ref, computed } from 'vue'
import { estimatedIntrinsics } from '../../core/sfm/cameraEstimated.js'
import { resolveK } from '../../core/sfm/reconstruction.js'
import { DISTORTION_MODELS, coeffsForModel } from '../../core/sfm/distortion.js'
import { parseRows, sniffDelimiter } from '../../core/io/gcp.js'

// Editable table of sensors (shared intrinsics). In 'initial' mode the numeric
// cells are editable inputs (the source of truth); in 'estimated' mode they show
// bundle-adjusted values aggregated from the reconstruction (read-only).
const props = defineProps({
  sensors: { type: Array,  required: true },
  images:  { type: Array,  default: () => [] },
  cameras: { type: Map,    default: () => new Map() }, // uuid → { R, t, K }
})

const emit = defineEmits(['update', 'remove', 'toggle-fixed', 'set-fiducial-marks'])

const isFixed = (s, field) => !!s.fixed?.[field]

// ── Film sensors: fiducial-mark interior orientation (F4) ─────────────────────
// A film sensor carries a calibrated fiducial layout (mm) + focal + principal
// point. The editor is an expandable detail row (only in Initial mode); marks are
// edited inline or pasted as `id, xMm, yMm` CSV. Digital is the default.
const isFilm = (s) => s.kind === 'film'
const expanded = ref(new Set())
function toggleExpand(id) {
  const next = new Set(expanded.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expanded.value = next
}
const fidMarks = (s) => s.fiducials?.marks ?? []
const fidCount = (s) => fidMarks(s).length

// Emit the full updated marks array (marks are few; simplest source of truth).
function editMark(s, idx, field, value) {
  const marks = fidMarks(s).map((m) => ({ ...m }))
  if (!marks[idx]) return
  if (field === 'id') marks[idx].id = String(value).trim() || marks[idx].id
  else marks[idx][field] = value === '' ? NaN : Number(value)
  emit('set-fiducial-marks', { id: s.id, marks })
}
function addMark(s) {
  const marks = fidMarks(s).map((m) => ({ ...m }))
  marks.push({ id: `F${marks.length + 1}`, xMm: 0, yMm: 0 })
  emit('set-fiducial-marks', { id: s.id, marks })
}
function removeMark(s, idx) {
  const marks = fidMarks(s).map((m) => ({ ...m }))
  marks.splice(idx, 1)
  emit('set-fiducial-marks', { id: s.id, marks })
}
// Parse a pasted certificate block (`id, xMm, yMm` per line) into marks.
const pasteText = ref({})
function applyPaste(s) {
  const text = pasteText.value[s.id] || ''
  if (!text.trim()) return
  const rows = parseRows(text, sniffDelimiter(text))
  const marks = []
  for (const cells of rows) {
    if (cells.length < 3) continue
    // Tolerate a header row: skip when the numeric columns aren't numbers.
    const xMm = Number(cells[1]), yMm = Number(cells[2])
    if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) continue
    marks.push({ id: cells[0] || `F${marks.length + 1}`, xMm, yMm })
  }
  if (marks.length) emit('set-fiducial-marks', { id: s.id, marks })
  pasteText.value = { ...pasteText.value, [s.id]: '' }
}

const mode = ref('initial') // 'initial' | 'estimated' | 'diff'

const round = (n, d = 2) => (n == null ? null : Number(n.toFixed(d)))
const signed = (n, d = 2) => (n == null ? null : (n >= 0 ? '+' : '') + n.toFixed(d))

function imageCount(sensorId) {
  return props.images.filter((i) => i.sensorId === sensorId).length
}

// Mean estimated intrinsics across this sensor's reconstructed images.
function estimated(sensorId) {
  const vals = []
  for (const img of props.images) {
    if (img.sensorId !== sensorId) continue
    const cam = props.cameras.get(img.uuid)
    const est = cam && estimatedIntrinsics(cam)
    if (est) vals.push(est)
  }
  if (!vals.length) return null
  const mean = (k) => {
    const xs = vals.map((v) => v[k]).filter((x) => x != null)
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  }
  return { focal: mean('focal'), cx: mean('cx'), cy: mean('cy'), n: vals.length }
}

const anyEstimated = computed(() => props.sensors.some((s) => estimated(s.id)))

// Flag sensors whose intrinsics fall back to resolveK()'s last resort — the
// default-FOV guess (fx = max(w,h)). That guess directly distorts SfM and depth
// maps (see CLAUDE.md), and is common for scanned/historic imagery with no usable
// EXIF focal. Evaluate resolveK per assigned image (it depends on per-image EXIF
// as well as the sensor); warn when any resolve to the fallback. Returns
// { count, total } per sensor id.
const fallbacks = computed(() => {
  const m = new Map()
  for (const s of props.sensors) {
    const imgs = props.images.filter((i) => i.sensorId === s.id)
    // No images yet: still flag a sensor that carries no usable focal on its own.
    const probe = imgs.length ? imgs : [{ meta: null }]
    let count = 0
    for (const img of probe) {
      if (resolveK(img.meta, s).source.startsWith('default FOV')) count++
    }
    m.set(s.id, { count, total: probe.length, hasImages: imgs.length > 0 })
  }
  return m
})

function fallbackTitle(s) {
  const fb = fallbacks.value.get(s.id)
  const scope = fb.hasImages ? `${fb.count} of ${fb.total} image(s)` : 'this sensor'
  return `No usable calibration for ${scope}: intrinsics fall back to a default ` +
    `field-of-view guess (focal ≈ image width), which distorts SfM and depth maps. ` +
    `Fix it below — set Focal in px, or Focal in mm plus either px size or film format.`
}

const hint = computed(() => ({
  initial:   'Calibration priors — editable',
  fixed:     'Tick a parameter to hold it constant during bundle adjustment',
  estimated: 'Bundle-adjusted (read-only), averaged per sensor',
  diff:      'Estimated − initial (Δ)',
}[mode.value]))

// Estimated − initial for an intrinsic, or null if either side is missing.
function diff(sensorId, key) {
  const est = estimated(sensorId)
  if (!est || est[key] == null) return null
  const s = props.sensors.find((x) => x.id === sensorId)
  const init = s?.[key]
  if (init == null || init === '') return null
  return est[key] - Number(init)
}

// Editable numeric columns (label handled separately). `focal` carries a
// px/mm unit toggle; `pixelSize`/`sensorWidthMm` convert an mm focal to pixels
// (a film/scanned-aerial camera: focal length + film format from a calibration
// sheet — fill either pixel size or format width, not both).
const NUM_COLS = [
  { key: 'width',        label: 'W' },
  { key: 'height',       label: 'H' },
  { key: 'focal',        label: 'Focal', lockable: true },
  { key: 'pixelSize',    label: 'px size (mm)' },
  { key: 'sensorWidthMm', label: 'format (mm)' },
  { key: 'cx',           label: 'cx', lockable: true },
  { key: 'cy',           label: 'cy', lockable: true },
  { key: 'k1',           label: 'k1', lockable: true },
  { key: 'k2',           label: 'k2', lockable: true },
  { key: 'k3',           label: 'k3', lockable: true },
  { key: 'p1',           label: 'p1', lockable: true },
  { key: 'p2',           label: 'p2', lockable: true },
]

// 'mm' unless explicitly pixels — a focal in mm needs a pixel size or format
// width to convert, so the mm-only columns are dimmed when the unit is px.
const focalInMm = (s) => s.focalUnit !== 'px'

// Distortion model (D3): which Brown coefficients this sensor uses. A coefficient
// input outside the active model is disabled (a stale value would not be applied
// anyway — distortionOf ignores it). No explicit model ⇒ all coefficients live
// (back-compat with sensors saved before models existed).
const DISTORTION_COEFFS = new Set(['k1', 'k2', 'k3', 'p1', 'p2'])
const activeCoeffs = (s) => new Set(coeffsForModel(s.distortionModel))
const coeffOff = (s, key) => DISTORTION_COEFFS.has(key) && !activeCoeffs(s).has(key)
const modelLabel = (s) =>
  DISTORTION_MODELS.find((m) => m.id === (s.distortionModel || 'pinhole'))?.label ?? '—'

function onEdit(id, field, e) {
  emit('update', { id, field, value: e.target.value })
}

// Total column count (Label, Source, Distortion, Kind, NUM_COLS, Images, ×) —
// the colspan for the full-width fiducial detail row.
const totalCols = computed(() => 4 + NUM_COLS.length + 2)
</script>

<template>
  <div class="table-wrap">
    <div class="toolbar">
      <div class="seg">
        <button class="seg-btn" :class="{ active: mode === 'initial' }" @click="mode = 'initial'">Initial</button>
        <button
          class="seg-btn"
          :class="{ active: mode === 'estimated' }"
          :disabled="!anyEstimated"
          :title="anyEstimated ? '' : 'Run a reconstruction to get estimated values'"
          @click="mode = 'estimated'"
        >Estimated</button>
        <button
          class="seg-btn"
          :class="{ active: mode === 'diff' }"
          :disabled="!anyEstimated"
          :title="anyEstimated ? '' : 'Run a reconstruction to compare values'"
          @click="mode = 'diff'"
        >Difference</button>
        <button class="seg-btn" :class="{ active: mode === 'fixed' }" @click="mode = 'fixed'">Fixed</button>
      </div>
      <span class="hint">{{ hint }}</span>
    </div>

    <table v-if="sensors.length">
      <thead>
        <tr>
          <th>Label</th>
          <th>Source</th>
          <th>Distortion</th>
          <th>Kind</th>
          <th v-for="c in NUM_COLS" :key="c.key">{{ c.label }}</th>
          <th>Images</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="s in sensors" :key="s.id">
        <tr>
          <td class="label-cell">
            <span class="label-wrap">
              <span
                v-if="fallbacks.get(s.id)?.count"
                class="warn-badge"
                :title="fallbackTitle(s)"
              >⚠</span>
              <input
                v-if="mode === 'initial'"
                class="cell-input label-input"
                :value="s.label"
                @change="onEdit(s.id, 'label', $event)"
              />
              <span v-else>{{ s.label }}</span>
            </span>
          </td>
          <td class="dim">{{ s.source === 'exif' ? 'EXIF' : 'imported' }}</td>

          <!-- Distortion model: editable selector in Initial, read-only elsewhere.
               Rendered once per row (outside the per-mode column templates). -->
          <td>
            <select
              v-if="mode === 'initial'"
              class="unit-select model-select"
              :value="s.distortionModel || 'pinhole'"
              title="Lens distortion model — which Brown coefficients this sensor uses (removed at ingest; the pipeline stays pinhole)"
              @change="onEdit(s.id, 'distortionModel', $event)"
            >
              <option v-for="m in DISTORTION_MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
            <span v-else class="dim">{{ modelLabel(s) }}</span>
          </td>

          <!-- Kind: digital (default) vs scanned film (fiducial interior orientation). -->
          <td>
            <span v-if="mode === 'initial'" class="kind-cell">
              <select
                class="unit-select"
                :value="s.kind || 'digital'"
                title="Camera kind — Film enables fiducial-mark interior orientation for scanned frames"
                @change="onEdit(s.id, 'kind', $event)"
              >
                <option value="digital">Digital</option>
                <option value="film">Film</option>
              </select>
              <button
                v-if="isFilm(s)"
                class="expand-btn"
                :class="{ open: expanded.has(s.id) }"
                :title="expanded.has(s.id) ? 'Hide fiducials' : `Edit fiducials (${fidCount(s)} mark${fidCount(s) === 1 ? '' : 's'})`"
                @click="toggleExpand(s.id)"
              >⛶ {{ fidCount(s) }}</button>
            </span>
            <span v-else class="dim">{{ isFilm(s) ? 'Film' : 'Digital' }}</span>
          </td>

          <template v-if="mode === 'initial'">
            <td v-for="c in NUM_COLS" :key="c.key">
              <!-- Focal: numeric input + px/mm unit toggle. For a film sensor the
                   focal lives in the fiducial editor (mm, authoritative for the
                   interior orientation) — show it read-only here to avoid two
                   editable focal fields that could drift. -->
              <span v-if="c.key === 'focal'" class="focal-cell">
                <template v-if="isFilm(s)">
                  <input
                    class="cell-input focal-input"
                    type="number"
                    disabled
                    title="Set in the fiducial editor (⛶) — Focal (mm)"
                    :value="s.fiducials?.focalMm ?? ''"
                  />
                  <span class="unit-static" title="Focal is in mm for a film sensor">mm</span>
                </template>
                <template v-else>
                  <input
                    class="cell-input focal-input"
                    type="number"
                    step="any"
                    :value="s.focal ?? ''"
                    @change="onEdit(s.id, 'focal', $event)"
                  />
                  <select
                    class="unit-select"
                    :value="s.focalUnit === 'px' ? 'px' : 'mm'"
                    title="Focal length unit"
                    @change="onEdit(s.id, 'focalUnit', $event)"
                  >
                    <option value="mm">mm</option>
                    <option value="px">px</option>
                  </select>
                </template>
              </span>
              <!-- Pixel size / format only apply to an mm focal. -->
              <input
                v-else-if="c.key === 'pixelSize' || c.key === 'sensorWidthMm'"
                class="cell-input"
                type="number"
                step="any"
                :disabled="!focalInMm(s)"
                :title="focalInMm(s) ? '' : 'Only used when focal is in mm'"
                :value="s[c.key] ?? ''"
                @change="onEdit(s.id, c.key, $event)"
              />
              <input
                v-else
                class="cell-input"
                type="number"
                step="any"
                :disabled="coeffOff(s, c.key)"
                :title="coeffOff(s, c.key) ? `Not used by the ${modelLabel(s)} model` : ''"
                :value="s[c.key] ?? ''"
                @change="onEdit(s.id, c.key, $event)"
              />
            </td>
          </template>
          <template v-else-if="mode === 'fixed'">
            <td v-for="c in NUM_COLS" :key="c.key" class="check-cell">
              <input
                v-if="c.lockable"
                type="checkbox"
                class="fix-check"
                :checked="isFixed(s, c.key)"
                :title="isFixed(s, c.key) ? 'Held constant by the solver' : 'Free to refine'"
                @change="emit('toggle-fixed', { id: s.id, field: c.key })"
              />
              <span v-else class="dim">—</span>
            </td>
          </template>
          <template v-else-if="mode === 'estimated'">
            <td>{{ s.width ?? '—' }}</td>
            <td>{{ s.height ?? '—' }}</td>
            <td :class="{ dim: !estimated(s.id) }">{{ round(estimated(s.id)?.focal) ?? '—' }}</td>
            <td class="dim">—</td>
            <td class="dim">—</td>
            <td :class="{ dim: !estimated(s.id) }">{{ round(estimated(s.id)?.cx) ?? '—' }}</td>
            <td :class="{ dim: !estimated(s.id) }">{{ round(estimated(s.id)?.cy) ?? '—' }}</td>
            <td v-for="c in ['k1','k2','k3','p1','p2']" :key="c" class="dim">—</td>
          </template>
          <template v-else>
            <td class="dim">—</td>
            <td class="dim">—</td>
            <td :class="{ dim: diff(s.id, 'focal') == null }">{{ signed(diff(s.id, 'focal')) ?? '—' }}</td>
            <td class="dim">—</td>
            <td class="dim">—</td>
            <td v-for="c in ['cx','cy']" :key="c" :class="{ dim: diff(s.id, c) == null }">
              {{ signed(diff(s.id, c)) ?? '—' }}
            </td>
            <td v-for="c in ['k1','k2','k3','p1','p2']" :key="c" class="dim">—</td>
          </template>

          <td class="count">{{ imageCount(s.id) }}</td>
          <td><button class="remove" title="Remove sensor" @click="emit('remove', s.id)">×</button></td>
        </tr>

        <!-- Fiducial editor: expandable detail row for a film sensor (Initial mode). -->
        <tr v-if="mode === 'initial' && isFilm(s) && expanded.has(s.id)" class="fid-row">
          <td :colspan="totalCols">
            <div class="fid-editor">
              <div class="fid-io">
                <label>Focal (mm)
                  <input class="cell-input" type="number" step="any" :value="s.fiducials?.focalMm ?? ''"
                    @change="onEdit(s.id, 'focalMm', $event)" /></label>
                <label>Principal x (mm)
                  <input class="cell-input" type="number" step="any" :value="s.fiducials?.ppxMm ?? ''"
                    @change="onEdit(s.id, 'ppxMm', $event)" /></label>
                <label>Principal y (mm)
                  <input class="cell-input" type="number" step="any" :value="s.fiducials?.ppyMm ?? ''"
                    @change="onEdit(s.id, 'ppyMm', $event)" /></label>
                <span class="fid-note" :class="{ warn: fidCount(s) < 3 }">
                  {{ fidCount(s) < 3 ? `≥3 marks needed (have ${fidCount(s)})` : `${fidCount(s)} marks` }}
                </span>
              </div>

              <table class="fid-marks">
                <thead><tr><th>ID</th><th>x (mm)</th><th>y (mm)</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="(m, i) in fidMarks(s)" :key="i">
                    <td><input class="cell-input mark-id" :value="m.id"
                      @change="editMark(s, i, 'id', $event.target.value)" /></td>
                    <td><input class="cell-input" type="number" step="any" :value="Number.isFinite(m.xMm) ? m.xMm : ''"
                      @change="editMark(s, i, 'xMm', $event.target.value)" /></td>
                    <td><input class="cell-input" type="number" step="any" :value="Number.isFinite(m.yMm) ? m.yMm : ''"
                      @change="editMark(s, i, 'yMm', $event.target.value)" /></td>
                    <td><button class="remove" title="Remove mark" @click="removeMark(s, i)">×</button></td>
                  </tr>
                </tbody>
              </table>
              <button class="add-mark" @click="addMark(s)">+ Add mark</button>

              <div class="fid-paste">
                <textarea
                  class="paste-area"
                  placeholder="Paste calibration: one line per mark — id, xMm, yMm"
                  :value="pasteText[s.id] || ''"
                  @input="pasteText = { ...pasteText, [s.id]: $event.target.value }"
                ></textarea>
                <button class="add-mark" @click="applyPaste(s)">Import pasted marks</button>
              </div>
            </div>
          </td>
        </tr>
        </template>
      </tbody>
    </table>

    <div v-else class="empty">No sensors yet — add images (auto-detected from EXIF) or import a calibration file.</div>
  </div>
</template>

<style scoped>
.table-wrap { position: absolute; inset: 0; overflow: auto; background: var(--bg); display: flex; flex-direction: column; }

.toolbar {
  position: sticky; top: 0; z-index: 2;
  display: flex; align-items: center; gap: 14px;
  padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--panel-border);
}

.seg { display: inline-flex; border: 1px solid var(--panel-border); border-radius: 5px; overflow: hidden; }
.seg-btn {
  background: var(--bg); border: none; color: var(--text-dim);
  font: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer;
}
.seg-btn + .seg-btn { border-left: 1px solid var(--panel-border); }
.seg-btn.active { background: var(--accent); color: #fff; }
.seg-btn:disabled { opacity: 0.4; cursor: default; }
.hint { font-size: 11px; color: var(--text-dim); }

table { width: 100%; border-collapse: collapse; font-size: 12px; }

thead th {
  position: sticky; top: 41px; z-index: 1;
  background: var(--panel); text-align: left; padding: 8px 10px;
  font-weight: 600; color: var(--text-dim); border-bottom: 1px solid var(--panel-border); white-space: nowrap;
}

tbody td { padding: 4px 10px; border-bottom: 1px solid var(--panel-border); white-space: nowrap; color: var(--text); }
tbody td.dim { color: var(--text-dim); }
.label-cell { min-width: 140px; }
.label-wrap { display: inline-flex; align-items: center; gap: 6px; }
.warn-badge {
  flex: none; cursor: help; font-size: 13px; line-height: 1;
  color: #e0a020; filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.4));
}
.count { text-align: center; font-variant-numeric: tabular-nums; }

.cell-input {
  width: 64px; background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 12px; padding: 3px 5px; outline: none;
}
.label-input { width: 130px; }
.cell-input:focus { border-color: var(--accent); }
.cell-input:disabled { opacity: 0.4; cursor: not-allowed; }

/* Focal cell: numeric input + compact px/mm unit selector. */
.focal-cell { display: inline-flex; gap: 4px; align-items: center; }
.focal-input { width: 52px; }
.unit-select {
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 11px; padding: 3px 2px; outline: none; cursor: pointer;
}
.unit-select:focus { border-color: var(--accent); }
.unit-static { font-size: 11px; color: var(--text-dim); }
.model-select { max-width: 180px; }

/* Numeric input without the up/down spinners — stepping makes no sense for
   calibration values, but we keep type=number for numeric keyboards/validation. */
.cell-input[type='number'] { -moz-appearance: textfield; appearance: textfield; }
.cell-input[type='number']::-webkit-outer-spin-button,
.cell-input[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

/* Fixed tab — checkbox per refinable intrinsic (held constant by the solver). */
.check-cell { text-align: center; }
.fix-check { width: 14px; height: 14px; accent-color: var(--accent); cursor: pointer; margin: 0; vertical-align: middle; }

.remove {
  background: none; border: none; color: var(--text-dim); cursor: pointer;
  font-size: 16px; line-height: 1; padding: 0 4px; border-radius: 4px;
}
.remove:hover { color: #e55; background: rgba(220, 80, 80, 0.12); }

.empty { padding: 40px; text-align: center; color: var(--text-dim); }

/* Film sensor: Kind cell + expandable fiducial editor (F4). */
.kind-cell { display: inline-flex; gap: 6px; align-items: center; }
.expand-btn {
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text-dim); font: inherit; font-size: 11px; padding: 2px 6px; cursor: pointer;
}
.expand-btn.open, .expand-btn:hover { border-color: var(--accent); color: var(--text); }

.fid-row td { background: var(--panel); }
.fid-editor { display: flex; flex-direction: column; gap: 10px; padding: 10px 4px; max-width: 640px; }
.fid-io { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.fid-io label { display: inline-flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--text-dim); }
.fid-note { font-size: 11px; color: var(--text-dim); align-self: center; }
.fid-note.warn { color: #e0a020; }

.fid-marks { width: auto; border-collapse: collapse; }
.fid-marks th { position: static; background: transparent; padding: 2px 8px 4px; font-size: 11px; }
.fid-marks td { padding: 2px 8px; border-bottom: none; }
.mark-id { width: 48px; }

.add-mark {
  align-self: flex-start;
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 11px; padding: 4px 10px; cursor: pointer;
}
.add-mark:hover { border-color: var(--accent); }
.fid-paste { display: flex; flex-direction: column; gap: 6px; }
.paste-area {
  width: 100%; min-height: 60px; resize: vertical;
  background: var(--bg); border: 1px solid var(--panel-border); border-radius: 4px;
  color: var(--text); font: inherit; font-size: 11px; padding: 6px; outline: none;
}
.paste-area:focus { border-color: var(--accent); }
</style>
