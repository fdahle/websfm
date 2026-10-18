<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import { previewFiducialObs } from '../../core/io/fiducialObs.js'
import { planFiducialMarkTargets } from '../../core/io/fiducialMarks.js'

// Preview before a fiducial import is applied (Import ▸ Image / Camera Fiducials, or
// a dropped file of either kind). The file is already parsed (core/io/fiducialObs.js,
// fiducialMarks.js); this shows what lands where, so a wrong file, a name mismatch
// or the wrong sensor shows up before anything is overwritten.
//   kind 'image'  — scan-pixel marks per image: rows grouped by image, matched to
//                   project images by name; existing marks in the same slot are replaced.
//   kind 'camera' — certificate marks in mm per sensor group: each group goes to a
//                   sensor (by label, else the only film / only sensor), changeable here.
const props = defineProps({
  // { kind: 'image', fileName, rows, layout } | { kind: 'camera', fileName, groups }
  data:    { type: Object, required: true },
  images:  { type: Array, default: () => [] },
  sensors: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'import'])

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const fmt = (v) => (Number.isFinite(v) ? String(+v.toFixed(3)) : '—')

// ── Image fiducials ─────────────────────────────────────────────────────────────

const preview = computed(() => (props.data.kind === 'image' ? previewFiducialObs(props.data.rows, props.images) : []))
const matched = computed(() => preview.value.filter((g) => g.imageId != null))
const matchedMarks = computed(() => matched.value.reduce((n, g) => n + g.marks.length, 0))
const replaced = computed(() => matched.value.reduce((n, g) => n + g.replaces, 0))
const shared = computed(() => matched.value.reduce((n, g) => n + g.shared, 0))
// The slot a mark lands in, with the file's own id when it differs ("1 → corner-tl").
const slotText = (m) => (m.slot == null || m.slot === m.fidId ? m.fidId : `${m.fidId} → ${m.slot}`)
const unmatched = computed(() => preview.value.filter((g) => g.imageId == null))

// Marks are drawn and used only on a film sensor's images; say so before importing.
const sensorById = computed(() => new Map(props.sensors.map((s) => [s.id, s])))
const notFilm = computed(() => {
  const byId = new Map(props.images.map((img) => [img.id, img]))
  return matched.value.filter((g) => sensorById.value.get(byId.get(g.imageId)?.sensorId)?.kind !== 'film').length
})

// ── Camera fiducials ────────────────────────────────────────────────────────────

const groups = computed(() => (props.data.kind === 'camera' ? props.data.groups : []))
const planned = computed(() => planFiducialMarkTargets(groups.value, props.sensors))
const targetChoice = ref({})
const targetOf = (i) => (i in targetChoice.value ? targetChoice.value[i] || null : planned.value[i])
const setTarget = (i, id) => { targetChoice.value = { ...targetChoice.value, [i]: id } }
const targets = computed(() => groups.value.map((_, i) => targetOf(i)))

// ── Result ──────────────────────────────────────────────────────────────────────

const canImport = computed(() => (props.data.kind === 'image'
  ? matchedMarks.value > 0
  : targets.value.some((t, i) => t && groups.value[i].marks.length)))
const importLabel = computed(() => (props.data.kind === 'image'
  ? `Import ${plural(matchedMarks.value, 'mark')}`
  : 'Import Marks'))

function doImport() {
  if (!canImport.value) return
  if (props.data.kind === 'image') {
    const keep = new Set(matched.value.map((g) => g.fileName))
    emit('import', { kind: 'image', rows: props.data.rows.filter((r) => keep.has(r.imageName)) })
  } else {
    emit('import', { kind: 'camera', groups: groups.value, targetIds: targets.value })
  }
}
</script>

<template>
  <ModalShell :title="data.kind === 'image' ? 'Import Image Fiducials' : 'Import Camera Fiducials'"
    :aria-label="data.kind === 'image' ? 'Import image fiducials' : 'Import camera fiducials'" width="640px" flush
    @close="emit('close')">
    <div class="import-body">
      <div class="filename">{{ data.fileName }}</div>

      <template v-if="data.kind === 'image'">
        <p class="kind-note">
          Fiducial positions in scan pixels, {{ data.layout === 'wide' ? 'one row per image' : 'one row per mark' }}.
          Files are matched to project images by name. A mark named by its slot keeps it; any other id is placed
          by its position on the scan. It replaces the image's mark in the same slot.
        </p>
        <div class="table-wrap">
          <table class="preview">
            <thead><tr><th>In file</th><th>Project image</th><th class="num">Marks</th><th>Slots</th></tr></thead>
            <tbody>
              <tr v-for="g in preview" :key="g.fileName" :class="{ missing: g.imageId == null }">
                <td class="mono">{{ g.fileName }}</td>
                <td>{{ g.imageName ?? 'not in the project' }}</td>
                <td class="num">{{ g.marks.length }}<span v-if="g.replaces" class="dim"> ({{ g.replaces }} replaced)</span></td>
                <td class="slots">{{ g.marks.map(slotText).join(', ') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="summary">
          <span v-if="matchedMarks" class="ok">
            {{ plural(matchedMarks, 'mark') }} for {{ plural(matched.length, 'image') }}<template v-if="replaced">, {{ replaced }} replacing existing marks</template>
          </span>
          <span v-else class="warn">No file name matches an image in the project.</span>
          <span v-if="unmatched.length" class="warn"> · {{ plural(unmatched.length, 'image') }} not in the project (skipped)</span>
        </div>
        <p v-if="shared" class="kind-note warn-note">
          {{ plural(shared, 'mark') }} land in a slot another mark of the same image also takes; the last one in the
          file is kept.
        </p>
        <p v-if="notFilm" class="kind-note warn-note">
          {{ plural(notFilm, 'image') }} {{ notFilm === 1 ? 'is' : 'are' }} not on a film sensor: the marks are kept,
          but drawn and used only once the sensor's kind is Film (sensor table, or Import ▸ Calibration).
        </p>
      </template>

      <template v-else>
        <p class="kind-note">Camera certificate marks in mm. Each group goes to a sensor, which becomes a film camera.</p>
        <p v-if="!sensors.length" class="kind-note warn-note">The project has no sensor yet. Add images first.</p>
        <section v-for="(g, i) in groups" :key="i" class="group">
          <div class="group-head">
            <div>
              <strong>{{ g.sensor || 'Marks' }}</strong>
              <span class="dim">
                {{ plural(g.marks.length, 'mark') }}<template v-if="g.focalMm != null"> · f {{ fmt(g.focalMm) }} mm</template><template
                  v-if="g.ppxMm != null || g.ppyMm != null"> · principal point {{ fmt(g.ppxMm) }}, {{ fmt(g.ppyMm) }} mm</template>
              </span>
            </div>
            <select class="ctrl-input" :value="targets[i] ?? ''" :aria-label="`Sensor for ${g.sensor || 'these marks'}`"
              @change="setTarget(i, $event.target.value)">
              <option value="">Skip</option>
              <option v-for="s in sensors" :key="s.id" :value="s.id">{{ s.label }}{{ s.kind === 'film' ? ' (film)' : '' }}</option>
            </select>
          </div>
          <div class="table-wrap">
            <table class="preview">
              <thead><tr><th>Mark</th><th class="num">x (mm)</th><th class="num">y (mm)</th><th>Slot</th></tr></thead>
              <tbody>
                <tr v-for="m in g.marks" :key="m.id">
                  <td class="mono">{{ m.id }}</td>
                  <td class="num mono">{{ fmt(m.xMm) }}</td>
                  <td class="num mono">{{ fmt(m.yMm) }}</td>
                  <td>{{ m.slot ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="targets[i] && sensorById.get(targets[i])?.fiducialCalibration?.marks?.length" class="kind-note warn-note">
            Replaces the {{ plural(sensorById.get(targets[i]).fiducialCalibration.marks.length, 'mark') }}
            {{ sensorById.get(targets[i]).label }} has now.
          </p>
        </section>
      </template>
    </div>

    <template #footer>
      <button class="btn-secondary" @click="emit('close')">Cancel</button>
      <button class="btn-primary" :disabled="!canImport" @click="doImport">{{ importLabel }}</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/import-modal.css"></style>
<style scoped>
.table-wrap { max-height: 300px; overflow: auto; border: 1px solid var(--panel-border); border-radius: 6px; }
.preview { width: 100%; border-collapse: collapse; font-size: 12px; }
.preview th {
  position: sticky; top: 0; background: var(--bg); text-align: left; font-weight: 600;
  color: var(--text-dim); padding: 6px 10px; border-bottom: 1px solid var(--panel-border);
}
.preview td { padding: 5px 10px; border-bottom: 1px solid var(--panel-border); }
.preview tr:last-child td { border-bottom: none; }
.preview .num { text-align: right; white-space: nowrap; }
.mono { font-family: monospace; }
.slots { color: var(--text-dim); }
.missing td { color: var(--text-dim); font-style: italic; }
.dim { color: var(--text-dim); margin-left: 6px; }
.warn { color: #d89a3a; }
.warn-note { color: #d89a3a; margin-top: 10px; }
.group + .group { margin-top: 18px; }
.group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: 13px; }
.group-head .ctrl-input { min-width: 180px; }
</style>
