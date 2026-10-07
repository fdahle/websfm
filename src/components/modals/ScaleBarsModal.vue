<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { LENGTH_UNITS, fromMetres } from '../../core/products/scale.js'
import { useScaleBarsStore } from '../../stores/useScaleBarsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useGcpsStore } from '../../stores/useGcpsStore.js'
import { useImagesStore } from '../../stores/useImagesStore.js'

// Scale Bars — declare known real-world distances so an up-to-scale model gets a
// metric unit. This is the object-capture counterpart of georeferencing: same job
// (fixing the datum), no CRS involved.
//
// Two things this modal must keep true:
//  • It shows a residual for EVERY bar, including ones that did not define the
//    scale (a georeferenced project's bars are checks) and ones that cannot be
//    measured yet (with the reason). A bar that disappears takes the user's
//    measurement with it.
//  • It never creates a control point and re-roles it. The guided "Mark point"
//    action creates a marker outright — see useGcpsStore.addPoint.
const emit = defineEmits(['close', 'mark-point'])

const scaleBars = useScaleBarsStore()
const recon = useReconstructionStore()
const gcpsStore = useGcpsStore()
const imagesStore = useImagesStore()

// Endpoint candidates. Markers are the marked kind; cameras are free — their
// centres are already known, so a surveyed camera pair or a calibrated rig
// baseline scales a project with no marking at all.
const markers = computed(() => gcpsStore.gcps.filter((g) => g.role === 'marker'))
const registeredImages = computed(() => {
  const cams = recon.sparseCameras
  return imagesStore.images.filter((im) => cams.has(im.uuid))
})

const markerById = (id) => markers.value.find((m) => m.id === id) ?? null
const endpointReady = (endpoint) => {
  if (!endpoint?.id) return false
  if (endpoint.kind === 'camera') return registeredImages.value.some((im) => im.id === endpoint.id)
  const marker = markerById(endpoint.id)
  return marker?.enabled !== false && (marker?.observations?.length ?? 0) >= 2
}
const endpointProgress = (endpoint) => {
  if (!endpoint?.id) return 'Not set'
  if (endpoint.kind === 'camera') return endpointReady(endpoint) ? endpointLabel(endpoint) : 'Camera is not registered'
  const marker = markerById(endpoint.id)
  if (!marker) return 'Point was removed'
  const count = marker.observations?.length ?? 0
  return `${marker.name} · ${count} of 2 photo marks${count >= 2 ? ' ✓' : ''}`
}

const endpointLabel = (e) => {
  if (!e?.id) return '—'
  if (e.kind === 'camera') return imagesStore.images.find((i) => i.id === e.id)?.name ?? '(image removed)'
  return gcpsStore.gcps.find((g) => g.id === e.id)?.name ?? '(marker removed)'
}
// One flat value per <select> option, because an endpoint is a (kind, id) pair.
const endpointValue = (e) => (e?.id ? `${e.kind}:${e.id}` : '')
function parseEndpoint(value) {
  if (!value) return null
  const i = value.indexOf(':')
  return { kind: value.slice(0, i), id: value.slice(i + 1) }
}

// ── The report ────────────────────────────────────────────────────────────────
// Rows come from the store (one measurement pass shared with the fit, so the two
// can never disagree). `scaleSource` says WHOSE metres these are.
const rows = ref([])
const busy = ref(false)
const resolved = ref({ unit: 'model', scale: 1, source: null })
const fitStatus = ref({ valid: false, reason: 'none' })

async function refresh() {
  busy.value = true
  try {
    resolved.value = await recon.effectiveFrameSpec()
    fitStatus.value = recon.scaleFitStatus()
    // Residuals are always against whatever currently DEFINES the scale — with a
    // georeference present the bars are checks against the CRS fit, not against a
    // scale they did not set.
    rows.value = await recon.scaleBarReport(resolved.value.unit !== 'model' ? resolved.value.scale : null)
  } finally {
    busy.value = false
  }
}
onMounted(refresh)
watch(() => scaleBars.bars.length, refresh)

const rowFor = (id) => rows.value.find((r) => r.id === id) ?? null

// Distances are stored in metres; the table shows them back in the unit the user
// typed. There is exactly one conversion boundary in each direction.
const shownDistance = (bar) => {
  const v = fromMetres(bar.knownDistanceM, bar.displayUnit)
  return v == null ? '' : round(v)
}
const shownAccuracy = (bar) => {
  const v = fromMetres(bar.accuracyM, bar.displayUnit)
  return v == null ? '' : round(v)
}
const round = (v) => Number(v.toPrecision(12))

function fmtM(v, digits = 4) {
  return v == null || !Number.isFinite(v) ? '—' : v.toPrecision(digits)
}
function fmtSigned(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toPrecision(3)} m`
}

const barReady = (bar) => endpointReady(bar?.a) && endpointReady(bar?.b)
  && Number.isFinite(bar?.knownDistanceM) && bar.knownDistanceM > 0
const canApply = computed(() => !busy.value && recon.sparseCameras.size > 0
  && scaleBars.bars.some((bar) => bar.enabled !== false && barReady(bar)))
const setupBar = computed(() => {
  const unfinished = [...scaleBars.bars].reverse().find((bar) => !barReady(bar))
  return unfinished ?? scaleBars.bars.at(-1) ?? null
})
const setupNeedsDistance = computed(() => setupBar.value
  && endpointReady(setupBar.value.a) && endpointReady(setupBar.value.b)
  && !(Number.isFinite(setupBar.value.knownDistanceM) && setupBar.value.knownDistanceM > 0))
const guidedAction = computed(() => {
  const bar = setupBar.value
  if (!bar || barReady(bar)) return {
    which: 'a', mode: 'new-bar',
    label: scaleBars.bars.length ? 'Mark point 1 for another distance' : 'Mark point 1 in photos',
  }
  for (const which of ['a', 'b']) {
    const endpoint = bar[which]
    if (endpointReady(endpoint)) continue
    const pointNumber = which === 'a' ? 1 : 2
    const existing = endpoint?.kind === 'marker' ? markerById(endpoint.id) : null
    return existing
      ? { which, mode: 'continue', id: existing.id, label: `Continue marking point ${pointNumber}` }
      : { which, mode: 'create', label: `Mark point ${pointNumber} in photos` }
  }
  return null
})

async function apply() {
  busy.value = true
  try {
    await recon.fitScaleBars()
  } finally {
    busy.value = false
  }
  await refresh()
}

function addBarFromExisting() {
  scaleBars.addBar()
}

// The guided path creates the bar and endpoint together, so the user never has
// to understand that a "marker" and a "scale bar" are separate storage objects.
// The App returns to this modal automatically after the point is marked twice.
function markGuidedEndpoint() {
  const action = guidedAction.value
  if (!action) return
  let bar = setupBar.value
  if (!bar || action.mode === 'new-bar') {
    const barId = scaleBars.addBar()
    bar = scaleBars.bars.find((b) => b.id === barId)
  }
  if (action.mode === 'continue') {
    emit('mark-point', action.id)
    return
  }
  const pointNumber = action.which === 'a' ? 1 : 2
  const id = gcpsStore.addPoint({ role: 'marker', name: `${bar.name} point ${pointNumber}` })
  scaleBars.updateBar(bar.id, { [action.which]: { kind: 'marker', id } })
  emit('mark-point', id)
}

function patch(bar, field, event) {
  const accepted = scaleBars.updateBar(bar.id, { [field]: event.target.value })
  if (accepted === false && field === 'accuracy') event.target.value = shownAccuracy(bar)
  refresh()
}
function patchEndpoint(bar, which, event) {
  scaleBars.updateBar(bar.id, { [which]: parseEndpoint(event.target.value) })
  refresh()
}
function toggle(bar, event) {
  scaleBars.setBarEnabled(bar.id, event.target.checked)
  refresh()
}
function remove(bar) {
  scaleBars.removeBar(bar.id)
  refresh()
}

// What the header line says about the current unit — the whole point of D9 is
// that a number never appears without its provenance.
const statusLine = computed(() => {
  if (resolved.value.source === 'georef') {
    return `This project is georeferenced (${resolved.value.crs}), so the georeference defines the scale. `
      + 'Bars below are reported as independent checks.'
  }
  if (resolved.value.source === 'scalebars') {
    return `Scale: ${recon.scaleFit.scale.toPrecision(6)} m per model unit `
      + `from ${recon.scaleFit.count} bar(s), RMS ${recon.scaleFit.rms.toPrecision(3)} m.`
  }
  if (recon.scaleFit && !fitStatus.value.valid) {
    return `The fitted scale is out of date (${fitStatus.value.reason}). Measurements are `
      + 'shown in model units until you apply again.'
  }
  return 'No scale yet — lengths in this project are up to scale (model units).'
})
</script>

<template>
  <ModalShell title="Set Real-World Scale" @close="emit('close')">
    <WarnBox v-if="!recon.sparseCameras.size">
      Build the sparse model first — a scale bar is measured <b>across the reconstruction</b>,
      so its endpoints need camera poses.
    </WarnBox>

    <p class="intro">
      Use one distance that you measured on the real object to convert this reconstruction
      from model units to metres. Pick two precise physical points—such as opposite corners
      of a ruler or object edge—and enter the real distance between them.
    </p>

    <div class="status" :class="{ stale: recon.scaleFit && !fitStatus.valid && resolved.source !== 'georef' }">
      {{ statusLine }}
    </div>

    <section class="workflow" aria-label="Scale setup steps">
      <div class="workflow-title">Set up a known distance</div>
      <div class="workflow-steps">
        <div class="workflow-step" :class="{ done: endpointReady(setupBar?.a), current: !endpointReady(setupBar?.a) }">
          <span class="step-number">1</span>
          <div>
            <strong>Mark the first physical point</strong>
            <small>{{ endpointProgress(setupBar?.a) }}</small>
          </div>
        </div>
        <div class="workflow-step" :class="{ done: endpointReady(setupBar?.b), current: endpointReady(setupBar?.a) && !endpointReady(setupBar?.b) }">
          <span class="step-number">2</span>
          <div>
            <strong>Mark the second physical point</strong>
            <small>{{ endpointProgress(setupBar?.b) }}</small>
          </div>
        </div>
        <div class="workflow-step" :class="{ done: barReady(setupBar), current: setupNeedsDistance }">
          <span class="step-number">3</span>
          <div>
            <strong>Enter the real measured distance</strong>
            <small>{{ barReady(setupBar) ? 'Ready to set the scale ✓' : (setupNeedsDistance ? 'Enter it in the highlighted row below' : 'After both points are marked') }}</small>
          </div>
        </div>
      </div>

      <template v-if="guidedAction">
        <button class="btn btn-primary workflow-action" :disabled="!recon.sparseCameras.size" @click="markGuidedEndpoint">
          {{ guidedAction.label }}
        </button>
        <p class="workflow-hint">
          This window will close. Click the <b>same physical point</b> in two different photos.
          After the second mark, this setup will reopen automatically.
        </p>
      </template>
      <p v-else-if="setupNeedsDistance" class="workflow-hint focus-hint">
        Both points are ready. Enter the distance you measured in the <b>Real distance</b>
        field below, choose its unit, then click <b>Set project scale</b>.
      </p>
    </section>

    <SettingsGroup title="Known distances">
      <div class="bars-toolbar">
        <button class="btn" :disabled="!recon.sparseCameras.size" title="Add a row and choose from points or registered camera centres that already exist" @click="addBarFromExisting">
          + Use existing points
        </button>
        <span class="toolbar-note">Advanced: camera centres can also be selected as endpoints.</span>
      </div>

      <div v-if="!scaleBars.bars.length" class="empty">
        Start with “Mark point 1 in photos” above. A known-distance row will be created automatically.
      </div>

      <div v-else class="table-scroll">
        <table class="bars">
          <thead>
            <tr>
              <th title="Include this bar in the fit">Use</th>
              <th>Label</th>
              <th>Point 1</th>
              <th>Point 2</th>
              <th title="The distance you measured in the real world">Real distance</th>
              <th title="Optional 1σ uncertainty of your real-world measurement. Leave blank for equal weight.">Uncertainty</th>
              <th>Unit</th>
              <th title="Distance between the points in the unscaled reconstruction">Model distance</th>
              <th title="Reconstructed distance after applying the current scale">Scaled result</th>
              <th title="Scaled result minus the real distance. Smaller is better.">Difference</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="bar in scaleBars.bars" :key="bar.id"
              :class="{ off: bar.enabled === false, setup: setupBar?.id === bar.id && setupNeedsDistance }">
              <td class="mid">
                <input type="checkbox" :checked="bar.enabled !== false" @change="toggle(bar, $event)" />
              </td>
              <td>
                <input class="field-input name" type="text" :value="bar.name"
                  @change="patch(bar, 'name', $event)" />
              </td>
              <td>
                <select class="field-select" :value="endpointValue(bar.a)" @change="patchEndpoint(bar, 'a', $event)">
                  <option value="">— pick —</option>
                  <optgroup v-if="markers.length" label="Markers">
                    <option v-for="m in markers" :key="m.id" :value="`marker:${m.id}`">{{ m.name }}</option>
                  </optgroup>
                  <optgroup v-if="registeredImages.length" label="Camera centres">
                    <option v-for="im in registeredImages" :key="im.id" :value="`camera:${im.id}`">{{ im.name }}</option>
                  </optgroup>
                </select>
              </td>
              <td>
                <select class="field-select" :value="endpointValue(bar.b)" @change="patchEndpoint(bar, 'b', $event)">
                  <option value="">— pick —</option>
                  <optgroup v-if="markers.length" label="Markers">
                    <option v-for="m in markers" :key="m.id" :value="`marker:${m.id}`">{{ m.name }}</option>
                  </optgroup>
                  <optgroup v-if="registeredImages.length" label="Camera centres">
                    <option v-for="im in registeredImages" :key="im.id" :value="`camera:${im.id}`">{{ im.name }}</option>
                  </optgroup>
                </select>
              </td>
              <td>
                <input class="field-input num" type="number" min="0" step="any"
                  :value="shownDistance(bar)" @change="patch(bar, 'knownDistance', $event)" />
              </td>
              <td>
                <input class="field-input num" type="number" min="0" step="any" placeholder="—"
                  :value="shownAccuracy(bar)" @change="patch(bar, 'accuracy', $event)" />
              </td>
              <td>
                <select class="field-select unit" :value="bar.displayUnit" @change="patch(bar, 'displayUnit', $event)">
                  <option v-for="(u, key) in LENGTH_UNITS" :key="key" :value="key">{{ u.label }}</option>
                </select>
              </td>
              <td class="num-cell">{{ fmtM(rowFor(bar.id)?.modelDistance, 6) }}</td>
              <td class="num-cell">
                <template v-if="rowFor(bar.id)?.measuredM != null">{{ fmtM(rowFor(bar.id).measuredM, 6) }} m</template>
                <span v-else class="dim">—</span>
              </td>
              <td class="num-cell">
                <span v-if="rowFor(bar.id)?.residualM != null"
                  :title="rowFor(bar.id).normalizedResidual != null
                    ? `${rowFor(bar.id).normalizedResidual.toFixed(2)}σ · ${rowFor(bar.id).weighting}`
                    : rowFor(bar.id).weighting">
                  {{ fmtSigned(rowFor(bar.id).residualM) }}
                  <small v-if="rowFor(bar.id).normalizedResidual != null" class="sigma">
                    · {{ rowFor(bar.id).normalizedResidual.toFixed(1) }}σ
                  </small>
                </span>
                <span v-else-if="rowFor(bar.id)?.reason" class="reason" :title="rowFor(bar.id).reason">
                  {{ rowFor(bar.id).reason }}
                </span>
                <span v-else class="dim">—</span>
              </td>
              <td class="mid">
                <button class="row-remove" title="Remove this bar" @click="remove(bar)">×</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </SettingsGroup>

    <template #footer>
      <span class="footer-note">
        Setting the scale applies one unit conversion to the whole project. It is re-checked against the
        model and your marks each time it is used.
      </span>
      <button class="btn" @click="emit('close')">Close</button>
      <button class="btn btn-primary" :disabled="!canApply" @click="apply">
        {{ busy ? 'Working…' : (resolved.source === 'scalebars' ? 'Recalculate scale' : 'Set project scale') }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.modal { width: min(96vw, 1100px); }

.intro { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--text-dim); }

.status {
  margin-bottom: 12px;
  padding: 7px 10px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
  background: var(--hover-bg);
  font-size: 12px;
  color: var(--text);
}
.status.stale { border-color: #b8860b; color: #e0a030; }

.workflow {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--panel-border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 6%, var(--bg));
}
.workflow-title { font-size: 12px; font-weight: 700; color: var(--text); }
.workflow-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.workflow-step {
  display: flex;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: var(--panel);
  opacity: 0.62;
}
.workflow-step.current, .workflow-step.done { opacity: 1; }
.workflow-step.current { border-color: var(--accent); }
.workflow-step.done .step-number { background: var(--accent); color: #fff; }
.workflow-step > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.workflow-step strong { font-size: 11px; line-height: 1.3; color: var(--text); }
.workflow-step small { font-size: 10px; line-height: 1.3; color: var(--text-dim); overflow-wrap: anywhere; }
.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 50%;
  background: var(--hover-bg);
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 700;
}
.workflow-action { align-self: flex-start; }
.workflow-hint { margin: -2px 0 0; font-size: 11px; line-height: 1.45; color: var(--text-dim); }
.focus-hint { color: var(--text); }

.bars-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.toolbar-note { font-size: 11px; color: var(--text-dim); }

.empty { font-size: 12px; color: var(--text-dim); padding: 10px 2px; }

.table-scroll { overflow-x: auto; }

table.bars { width: 100%; border-collapse: collapse; font-size: 12px; }
table.bars th {
  text-align: left;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 1px solid var(--panel-border);
  padding: 4px 6px;
  white-space: nowrap;
}
table.bars td { padding: 3px 6px; border-bottom: 1px solid var(--panel-border); vertical-align: middle; }
table.bars tr.off { opacity: 0.5; }
table.bars tr.setup { background: color-mix(in srgb, var(--accent) 9%, transparent); }

td.mid { text-align: center; }
.num-cell { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dim { color: var(--text-dim); }
.sigma { color: var(--text-dim); }
.reason { color: #e0a030; font-size: 11px; }

.field-input.name { width: 110px; }
.field-input.num { width: 84px; text-align: right; }
.field-select.unit { width: 60px; min-width: 0; }

.row-remove {
  background: none; border: none; color: var(--text-dim);
  font-size: 15px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 3px;
}
.row-remove:hover { background: var(--hover-bg); color: #e05555; }

.footer-note { flex: 1; font-size: 11px; color: var(--text-dim); }

@media (max-width: 760px) {
  .workflow-steps { grid-template-columns: 1fr; }
}
</style>
