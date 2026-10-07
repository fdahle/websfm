<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { CROP_CLOUD_DEFAULTS } from '../../core/defaults.user.js'
import { cloudBounds, cloudCount } from '../../core/products/cloudEdit.js'

// Crop Cloud — keep the points inside (or outside) an axis-aligned box. Editing is
// non-destructive: the run adds a NEW cloud and leaves the source alone. With
// `mesh`, the same box crops a mesh (Tools ▸ Mesh ▾ ▸ Crop): a triangle survives
// when all three corners are inside (core/products/meshEdit.js `cropMesh`), and the
// live count counts vertices.
//
// `clouds` are the editable clouds (kind:'dense', computed or imported) — sparse
// clouds are deliberately not croppable, see core/products/cloudEdit.js.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  mesh: { type: Boolean, default: false },
  initialId: { type: String, default: null },
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...CROP_CLOUD_DEFAULTS })
const sourceId = ref(props.clouds.some((c) => c.id === props.initialId) ? props.initialId : props.clouds[0]?.id ?? null)
const picked = computed(() => props.clouds.find((c) => c.id === sourceId.value) ?? null)
// The points the box is tested against: a cloud's points, or a mesh's vertices.
const source = computed(() => (picked.value && props.mesh
  ? { count: picked.value.nVerts, pos: picked.value.pos } : picked.value))
const noun = computed(() => (props.mesh ? 'vertices' : 'points'))

const AXES = [
  { key: 'X', min: 'minX', max: 'maxX' },
  { key: 'Y', min: 'minY', max: 'maxY' },
  { key: 'Z', min: 'minZ', max: 'maxZ' },
]

// Prefill the box from the source's own bbox, so the initial state is "keep
// everything" and the user shrinks from there rather than guessing coordinates.
function fillFromBounds() {
  const b = source.value ? cloudBounds(source.value) : null
  if (!b) return
  const r = (v) => Number(v.toFixed(3))
  settings.value = {
    ...settings.value,
    minX: r(b.minX), minY: r(b.minY), minZ: r(b.minZ),
    maxX: r(b.maxX), maxY: r(b.maxY), maxZ: r(b.maxZ),
  }
}
watch(source, fillFromBounds, { immediate: true })

// ── Live kept-point count ───────────────────────────────────────────────────
// A bbox test is one linear pass, so a debounced main-thread count is affordable
// and makes the numeric fields legible. Above the guard it is not — a 20 M+ pass on
// every keystroke would jank the UI — so we say "run to see" rather than freeze.
const LIVE_COUNT_LIMIT = 20_000_000
const liveKept = ref(null)
const countable = computed(() => cloudCount(source.value) > 0 && cloudCount(source.value) <= LIVE_COUNT_LIMIT)
let timer = null

function recount() {
  if (!countable.value) { liveKept.value = null; return }
  const { pos } = source.value
  const n = cloudCount(source.value)
  const s = settings.value
  const lo = [s.minX, s.minY, s.minZ].map((v) => (Number.isFinite(v) ? v : -Infinity))
  const hi = [s.maxX, s.maxY, s.maxZ].map((v) => (Number.isFinite(v) ? v : Infinity))
  let kept = 0
  for (let i = 0; i < n; i++) {
    const inside = pos[i * 3] >= lo[0] && pos[i * 3] <= hi[0]
      && pos[i * 3 + 1] >= lo[1] && pos[i * 3 + 1] <= hi[1]
      && pos[i * 3 + 2] >= lo[2] && pos[i * 3 + 2] <= hi[2]
    if (inside !== s.invert) kept++
  }
  liveKept.value = kept
}
watch([settings, source], () => {
  clearTimeout(timer)
  timer = setTimeout(recount, 250)
}, { deep: true, immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

const sourceCount = computed(() => cloudCount(source.value))

function run() {
  const s = settings.value
  const num = (v) => (Number.isFinite(v) ? v : null)
  emit('run', {
    sourceIds: [sourceId.value],
    settings: {
      min: [num(s.minX), num(s.minY), num(s.minZ)],
      max: [num(s.maxX), num(s.maxY), num(s.maxZ)],
      invert: !!s.invert,
    },
    name: `${picked.value?.name ?? (props.mesh ? 'Mesh' : 'Cloud')} (cropped)`,
  })
}
</script>

<template>
  <ModalShell :title="mesh ? 'Crop Mesh' : 'Crop Cloud'" @close="emit('close')">
    <WarnBox v-if="!clouds.length && mesh">No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.</WarnBox>
    <WarnBox v-else-if="!clouds.length">
      No editable point cloud. Run <strong>Densify</strong> or import a cloud first — cropping
      applies to dense clouds; a sparse cloud carries the view-tracks the later stages read
      and is left intact on purpose.
    </WarnBox>

    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField :label="mesh ? 'Mesh' : 'Cloud'" label-for="crop-src"
          :hint="mesh ? 'The crop adds a new mesh; this one is left untouched.' : 'The crop adds a new cloud; this one is left untouched.'">
          <select id="crop-src" v-model="sourceId" class="field-select">
            <option v-for="c in clouds" :key="c.id" :value="c.id">
              {{ c.name }} — {{ c.count.toLocaleString() }} {{ mesh ? 'triangles' : 'points' }}
            </option>
          </select>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Bounds">
        <SettingsField v-for="a in AXES" :key="a.key" :label="a.key"
          hint="Leave a field empty to leave that side unbounded.">
          <div class="input-row">
            <input v-model.number="settings[a.min]" type="number" step="any" class="field-input" placeholder="min" />
            <input v-model.number="settings[a.max]" type="number" step="any" class="field-input" placeholder="max" />
          </div>
        </SettingsField>

        <SettingsField hint="Reset the box to the full extent of the source cloud.">
          <button type="button" class="btn" @click="fillFromBounds">Use full extent</button>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Mode">
        <SettingsField hint="Keep what falls outside the box instead of inside it.">
          <template #label>Invert</template>
          <label class="checkbox-row">
            <input v-model="settings.invert" type="checkbox" class="checkbox" /> Keep outside the box
          </label>
        </SettingsField>
      </SettingsGroup>

      <p class="field-hint">
        <template v-if="liveKept !== null">
          Keeps {{ liveKept.toLocaleString() }} of {{ sourceCount.toLocaleString() }} {{ noun }}.
        </template>
        <template v-else>
          {{ sourceCount.toLocaleString() }} {{ noun }} — too many to count live; run to see the result.
        </template>
      </p>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!source || liveKept === 0" @click="run">Crop</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
