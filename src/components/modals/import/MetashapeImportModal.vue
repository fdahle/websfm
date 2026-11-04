<script setup>
// Import ▸ Interoperability ▸ Metashape: the calibration, camera poses and markers of
// one chunk of a Metashape XML export or project (core/io/metashapeXml.js), placed in
// the project's coordinate system (composables/metashapeImport.js). Each part goes
// through the importer it would take as a file of its own: Import ▸ Calibration,
// Camera Poses and GCPs. A project (.psz, .psx) adds its tie points as keypoints,
// matches and a sparse model, and its mesh (core/io/metashapeProject.js).
import { computed, reactive, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import { planMetashapeImport } from '../../../composables/metashapeImport.js'
import { scaleSensorTo } from '../../../core/io/metashapeXml.js'
import { planSensorImport } from '../../../core/io/sensor.js'
import { makeNameResolver } from '../../../core/io/nameMatch.js'
import { pluralize } from '../../../core/textFormat.js'
import { datumLabel } from '../../../core/verticalDatum.js'

const props = defineProps({
  data: { type: Object, required: true }, // { fileName, doc, project? } (composables/metashapeProjectFiles.js)
  projectCrs: { type: String, required: true },
  sensors: { type: Array, default: () => [] },
  images: { type: Array, default: () => [] },
  existingGcps: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'import'])

const chunks = computed(() => props.data.doc.chunks)
const chunkIndex = ref(
  Math.max(
    0,
    chunks.value.findIndex((c) => c.enabled),
  ),
)
const chunk = computed(() => chunks.value[chunkIndex.value])
const plan = ref(null)
const failed = ref(null)
const options = reactive({
  calibration: true,
  poses: true,
  gcps: true,
  scaleBars: true,
  features: true,
  verify: false,
  model: true,
  mesh: true,
})
// A project's tie points and mesh, for the chosen chunk.
const assets = computed(() => props.data.project?.chunks?.[chunkIndex.value] ?? null)
const isProject = computed(() => !!props.data.project)

watch(
  [chunk, () => props.projectCrs],
  async ([c, crs]) => {
    plan.value = null
    failed.value = null
    try {
      const p = await planMetashapeImport(c, crs)
      if (c === chunk.value) plan.value = p
    } catch (err) {
      failed.value = err?.message ?? String(err)
    }
  },
  { immediate: true },
)

// Each calibration at the size of its photos here: Metashape may have run on other
// copies of them (a pixel focal is taken as it stands, so it has to fit).
const sized = computed(() => {
  const resolve = makeNameResolver(props.images)
  const byId = new Map(props.images.map((im) => [im.id, im]))
  const sensors = [],
    notes = []
  for (const s of plan.value?.sensors ?? []) {
    const photo = s.images.map((n) => byId.get(resolve(n))).find((im) => im?.meta?.width > 0)
    const w = photo?.meta.width,
      h = photo?.meta.height
    const scaled = photo ? scaleSensorTo(s, w, h) : s
    if (!scaled)
      notes.push(
        `Calibration of ${s.label}: made for ${s.width} × ${s.height} photos, these are ${w} × ${h} (cropped?); left out.`,
      )
    else {
      if (scaled !== s)
        notes.push(`Calibration of ${s.label}: made for ${s.width} × ${s.height} photos, scaled to these ${w} × ${h}.`)
      sensors.push(scaled)
    }
  }
  return { sensors, notes }
})
const sensorPlan = computed(() => planSensorImport(sized.value.sensors, props.sensors, props.images))
// Metashape names a camera by its photo, usually without the extension: each pose and
// mark takes the name of the project photo it resolves to, so it joins that photo's
// pose instead of standing beside it. Poses of photos not in the project stay behind.
const projectName = computed(() => {
  const resolve = makeNameResolver(props.images)
  const nameOf = new Map(props.images.map((im) => [im.id, im.name]))
  return (name) => nameOf.get(resolve(name)) ?? null
})
const poses = computed(() =>
  (plan.value?.poses ?? []).flatMap((p) => {
    const name = projectName.value(p.imageName)
    return name ? [{ ...p, imageName: name }] : []
  }),
)
const gcps = computed(() =>
  (plan.value?.gcps ?? []).map((g) => ({
    ...g,
    observations: g.observations.map((o) => ({ ...o, imageName: projectName.value(o.imageName) ?? o.imageName })),
  })),
)
// Scale bars whose endpoints are markers (imported with the GCPs, or already here) or
// photos of this project.
const scaleBars = computed(() =>
  (plan.value?.scaleBars ?? []).flatMap((sb) => {
    const end = (e) => (e.kind === 'camera' ? { ...e, name: projectName.value(e.name) } : e)
    const a = end(sb.a),
      b = end(sb.b)
    return a.name && b.name ? [{ ...sb, a, b }] : []
  }),
)
const joining = computed(() => {
  const names = new Set(props.existingGcps.map((g) => g.name))
  return (plan.value?.gcps ?? []).filter((g) => names.has(g.name)).length
})
const sensorSummary = computed(() => {
  const updated = sensorPlan.value.filter((o) => o.target).length
  const created = sensorPlan.value.length - updated
  return [updated && `updates ${pluralize(updated, 'camera group')}`, created && `${created} new`]
    .filter(Boolean)
    .join(', ')
})
// The tie points of photos in this project.
const tie = computed(() => {
  const t = assets.value?.tiePoints
  if (!t) return null
  const inProject = new Set(t.keypoints.map((k) => k.label).filter((l) => projectName.value(l)))
  const pairs = t.pairs.filter((p) => inProject.has(p.a) && inProject.has(p.b))
  const cameras = t.model.images.filter((im) => projectName.value(im.name)).length
  return { t, photos: inProject.size, pairs, cameras }
})
// What the project holds that WebSfM does not read, and how to bring it in instead.
const unread = computed(() => {
  const h = assets.value?.has ?? {}
  return [
    h.denseCloud && 'the dense cloud (File ▸ Export ▸ Export Point Cloud as LAS/LAZ, then Import ▸ Point Cloud / Mesh)',
    h.elevation && 'the DEM (Export DEM as GeoTIFF, then Import ▸ Reference DEM / Ortho)',
    h.orthomosaic && 'the orthomosaic (Export Orthomosaic as GeoTIFF, then Import ▸ Reference DEM / Ortho)',
    h.depthMaps && 'the depth maps (Build Depth Maps here instead)',
  ].filter(Boolean)
})
const crsLabel = computed(() => (chunk.value.crs.local ? 'Local frame' : (chunk.value.crs.epsg ?? 'Unnamed CRS')))
const has = computed(() => ({
  calibration: sized.value.sensors.length > 0,
  poses: poses.value.length > 0,
  gcps: !!plan.value?.gcps.length,
  scaleBars: scaleBars.value.length > 0,
  features: (tie.value?.photos ?? 0) > 0,
  model: (tie.value?.cameras ?? 0) >= 2 && (tie.value?.t.counts.points ?? 0) > 0,
  mesh: !!assets.value?.mesh,
}))
const canImport = computed(
  () =>
    !!plan.value &&
    ((options.calibration && has.value.calibration) ||
      (options.poses && has.value.poses) ||
      (options.gcps && has.value.gcps) ||
      (options.scaleBars && has.value.scaleBars) ||
      (options.features && has.value.features) ||
      (options.model && has.value.model) ||
      (options.mesh && has.value.mesh)),
)
const importReason = computed(() =>
  canImport.value ? null : !plan.value ? 'Still reading the file' : 'Choose something to import',
)

function doImport() {
  if (!canImport.value) return
  emit('import', {
    sensorItems:
      options.calibration && has.value.calibration
        ? sensorPlan.value.map((o, i) => ({ sensor: sized.value.sensors[i], targetId: o.target, imageIds: o.imageIds }))
        : [],
    poses: options.poses ? poses.value : [],
    gcps: options.gcps ? gcps.value : [],
    scaleBars: options.scaleBars ? scaleBars.value : [],
    crs: props.projectCrs,
    verticalDatum: chunk.value.crs.verticalDatum,
    project: isProject.value
      ? {
          features:
            options.features && has.value.features
              ? { keypoints: tie.value.t.keypoints, pairs: tie.value.pairs, verify: options.verify }
              : null,
          model: options.model && has.value.model ? tie.value.t.model : null,
          mesh: options.mesh && has.value.mesh ? assets.value.mesh : null,
        }
      : null,
  })
}
</script>

<template>
  <ModalShell title="Import from Metashape" @close="emit('close')">
    <div class="source-head">
      <div>
        <strong>{{ isProject ? 'Metashape project' : 'Metashape XML' }}</strong
        ><span>{{ data.fileName }}</span>
      </div>
      <span>{{ crsLabel }}</span>
    </div>

    <div v-if="chunks.length > 1" class="field">
      <label for="ms-chunk">Chunk</label>
      <select id="ms-chunk" v-model="chunkIndex" class="field-select">
        <option v-for="(c, i) in chunks" :key="i" :value="i">
          {{ c.label }} — {{ pluralize(c.cameras.length, 'camera') }}
        </option>
      </select>
    </div>

    <div v-if="failed" class="notice error">{{ failed }}</div>
    <div v-else-if="!plan" class="notice">Reading {{ chunk.label }}…</div>
    <template v-else>
      <div class="stats">
        <div>
          <strong>{{ plan.counts.aligned }}</strong
          ><span>of {{ plan.counts.cameras }} cameras aligned</span>
        </div>
        <div>
          <strong>{{ plan.counts.sensors }}</strong
          ><span>calibrated {{ plan.counts.sensors === 1 ? 'camera' : 'cameras' }}</span>
        </div>
        <div>
          <strong>{{ plan.counts.markers }}</strong
          ><span>markers, {{ plan.counts.marks }} marks</span>
        </div>
      </div>

      <fieldset>
        <legend>Import</legend>
        <label
          :title="has.calibration ? null : 'The file has no calibration for photos in this project'"
          :class="{ disabled: !has.calibration }"
          ><input
            v-model="options.calibration"
            type="checkbox"
            :disabled="!has.calibration"
            :title="has.calibration ? null : 'The file has no calibration for photos in this project'"
          />
          Calibration <span v-if="has.calibration" class="muted">— {{ sensorSummary }}</span></label
        >
        <label
          :title="has.poses ? null : 'None of its aligned photos is in this project'"
          :class="{ disabled: !has.poses }"
          ><input
            v-model="options.poses"
            type="checkbox"
            :disabled="!has.poses"
            :title="has.poses ? null : 'None of its aligned photos is in this project'"
          />
          Camera positions and orientations
          <span v-if="has.poses" class="muted"
            >— {{ pluralize(poses.length, 'photo') }} of this project in {{ projectCrs }}, as priors</span
          ><span v-else-if="plan.poses.length" class="muted">— none of its photos is in this project</span></label
        >
        <label :title="has.gcps ? null : 'The file has no GCPs or markers'" :class="{ disabled: !has.gcps }"
          ><input
            v-model="options.gcps"
            type="checkbox"
            :disabled="!has.gcps"
            :title="has.gcps ? null : 'The file has no GCPs or markers'"
          />
          GCPs and markers with their marks
          <span v-if="has.gcps" class="muted"
            >— {{ pluralize(plan.gcps.length, 'point')
            }}<template v-if="joining">, {{ joining }} joining a GCP of the same name</template
            ><template v-if="!chunk.crs.local">, heights {{ datumLabel(chunk.crs.verticalDatum) }}</template></span
          ></label
        >
        <label
          :title="has.scaleBars ? null : 'None of its scale bars ends on a marker or photo in this project'"
          v-if="plan.scaleBars.length"
          :class="{ disabled: !has.scaleBars }"
          ><input
            v-model="options.scaleBars"
            type="checkbox"
            :disabled="!has.scaleBars"
            :title="has.scaleBars ? null : 'None of its scale bars ends on a marker or photo in this project'"
          />
          Scale bars
          <span v-if="has.scaleBars" class="muted"
            >— {{ pluralize(scaleBars.length, 'bar') }}, {{ scaleBars.filter((b) => !b.enabled).length }} as
            checks</span
          ><span v-else class="muted">— their photos are not in this project</span></label
        >
      </fieldset>
      <fieldset v-if="isProject">
        <legend>From the project</legend>
        <label
          :title="has.features ? null : 'The project has no tie points on photos in this project'"
          :class="{ disabled: !has.features }"
          ><input
            v-model="options.features"
            type="checkbox"
            :disabled="!has.features"
            :title="has.features ? null : 'The project has no tie points on photos in this project'"
          />
          Keypoints and matches
          <span v-if="has.features" class="muted"
            >— the tie points of {{ pluralize(tie.photos, 'photo') }}, {{ pluralize(tie.pairs.length, 'pair') }}</span
          ></label
        >
        <label v-if="options.features && has.features" class="indent"
          ><input v-model="options.verify" type="checkbox" /> Check the matches geometrically again, as Match Features
          does</label
        >
        <label
          :title="has.model ? null : 'Fewer than two of its aligned photos are in this project'"
          :class="{ disabled: !has.model }"
          ><input
            v-model="options.model"
            type="checkbox"
            :disabled="!has.model"
            :title="has.model ? null : 'Fewer than two of its aligned photos are in this project'"
          />
          Sparse model
          <span v-if="tie" class="muted"
            >— {{ pluralize(tie.cameras, 'aligned camera') }}, {{ tie.t.counts.points.toLocaleString() }} tie
            points</span
          ></label
        >
        <label :title="has.mesh ? null : 'The project has no mesh'" :class="{ disabled: !has.mesh }"
          ><input
            v-model="options.mesh"
            type="checkbox"
            :disabled="!has.mesh"
            :title="has.mesh ? null : 'The project has no mesh'"
          />
          Mesh
          <span v-if="has.mesh" class="muted"
            >— {{ assets.mesh.count.toLocaleString() }} triangles, in the frame of the sparse model</span
          ></label
        >
      </fieldset>
      <p v-if="isProject && unread.length" class="hint">Not read: {{ unread.join('; ') }}.</p>
      <p v-if="!isProject" class="hint">
        Export Cameras holds the calibration and the cameras; Export Markers holds those and the markers too.
      </p>
      <ul v-if="plan.warnings.length || sized.notes.length || data.project?.notes?.length" class="warnings">
        <li v-for="w in [...sized.notes, ...plan.warnings, ...(data.project?.notes ?? [])]" :key="w">{{ w }}</li>
      </ul>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canImport" :title="importReason" @click="doImport">Import</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.source-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 14px;
}
.source-head div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.source-head span,
.hint,
.muted {
  color: var(--text-dim);
  font-size: 12px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 14px;
}
.stats div {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
}
.stats span {
  color: var(--text-dim);
  font-size: 12px;
}
fieldset {
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
label.disabled {
  opacity: 0.55;
}
.indent {
  margin-left: 23px;
}
.warnings {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--warn, #d9a441);
}
.field {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}
</style>
