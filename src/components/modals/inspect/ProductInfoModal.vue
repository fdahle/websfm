<script setup>
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { useFootprintsStore } from '../../../stores/useFootprintsStore.js'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import { useGcpsStore } from '../../../stores/useGcpsStore.js'
import { useMatchesStore } from '../../../stores/useMatchesStore.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'
import { useAppContext } from '../../../appContext.js'
import { DISTORTION_MODELS, distortionOf } from '../../../core/sfm/distortion.js'
import {
  cloudInfo,
  rasterInfo,
  referenceRasterInfo,
  vectorSetInfo,
  sensorInfo,
  gcpInfo,
  matchesInfo,
} from '../../../core/products/productInfo.js'
import ModalShell from '../ui/ModalShell.vue'

// Right-click ▸ Show information on a sidebar row: a sparse, dense or mesh cloud
// ({ cloudId }), a DEM / orthophoto ({ productId }), a reference raster
// ({ rasterId }), a vector layer ({ vectorSetId }), a sensor ({ sensorId }), a
// control point ({ gcpId }) or the matches ({ matches: true }). The rows are
// core/products/productInfo.js.
const props = defineProps({
  target: { type: Object, required: true },
})
const emit = defineEmits(['close'])

const recon = useReconstructionStore()
const { clouds, summary, rasterProducts } = storeToRefs(recon)
const { images } = storeToRefs(useImagesStore())
const { rasters } = storeToRefs(useExternalStore())
const { sets } = storeToRefs(useFootprintsStore())
const sensorsStore = useSensorsStore()
const { sensors } = storeToRefs(sensorsStore)
const { gcps } = storeToRefs(useGcpsStore())
const { matchStore } = storeToRefs(useMatchesStore())
const { currentCrs } = storeToRefs(useProjectsStore())
const { gcpReport, matchStats, incompleteSensorIds } = useAppContext()

const byId = (list, id) => (id ? (list.find((x) => x.id === id) ?? null) : null)
const cloud = computed(() => byId(clouds.value, props.target.cloudId))
const raster = computed(() => byId(rasterProducts.value, props.target.productId))
const reference = computed(() => byId(rasters.value, props.target.rasterId))

// The lens model when it changes anything, as the Sensors row shows it.
const lensLabel = (s) =>
  distortionOf(s) ? (DISTORTION_MODELS.find((m) => m.id === s.distortionModel)?.label ?? 'Brown') : null

const info = computed(() => {
  const t = props.target
  if (t.rasterId) return reference.value ? referenceRasterInfo(reference.value) : null
  if (t.vectorSetId) {
    const set = byId(sets.value, t.vectorSetId)
    return set ? vectorSetInfo(set, { crs: currentCrs.value }) : null
  }
  if (t.sensorId) {
    const s = byId(sensors.value, t.sensorId)
    return s
      ? sensorInfo(s, {
          imageCount: sensorsStore.imageCount(s.id),
          incomplete: incompleteSensorIds.value.has(s.id),
          lens: lensLabel(s),
        })
      : null
  }
  if (t.gcpId) {
    const g = byId(gcps.value, t.gcpId)
    return g
      ? gcpInfo(g, { crs: currentCrs.value, report: gcpReport.value.find((r) => r.gcpId === g.id) ?? null })
      : null
  }
  if (t.matches)
    return matchStats.value.total
      ? matchesInfo(matchStore.value, matchStats.value, { imageCount: images.value.length })
      : null

  const record = cloud.value ?? raster.value
  if (!record) return null
  const isMain = recon.isMainProduct(record)
  const status = recon.productStatus(record)
  const ctx = { isMain, outdated: status.outdated ? status.reason : null }
  if (cloud.value)
    return cloudInfo(cloud.value, {
      ...ctx,
      imageCount: images.value.length,
      // The run summary describes the main model, not a comparison cloud.
      summary: isMain && cloud.value.kind === 'sparse' ? summary.value : null,
    })
  return rasterInfo(raster.value.kind, raster.value, ctx)
})
const previewUrl = computed(() => raster.value?.previewUrl ?? reference.value?.previewDataUrl ?? null)

// The item was removed (or rebuilt away) while the dialog was open.
watch(info, (now) => {
  if (!now) emit('close')
})

// No Escape listener of its own: useModalEscape (`infoProduct`) closes it in
// stacking order, as for ImageInfoModal.
</script>

<template>
  <ModalShell v-if="info" :title="info.title" width="440px" flush @close="emit('close')">
    <template #header>
      <span class="info-title" :title="info.title">{{ info.title }}</span>
    </template>

    <div v-if="previewUrl" class="preview">
      <img :src="previewUrl" :alt="info.title" class="preview-img" />
    </div>

    <dl class="meta">
      <template v-for="row in info.rows" :key="row.label">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </template>
    </dl>
  </ModalShell>
</template>

<style scoped>
/* As ImageInfoModal: a smaller title that ellipsizes, clear of the close button. */
.info-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.preview {
  background: #000;
  text-align: center;
  flex-shrink: 0;
}

.preview-img {
  max-width: 100%;
  max-height: 200px;
  object-fit: contain;
}

.meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 5px 16px;
  padding: 14px 16px;
  font-size: 12px;
}

.meta dt {
  color: var(--text-dim);
}

.meta dd {
  text-align: right;
  word-break: break-word;
}
</style>
