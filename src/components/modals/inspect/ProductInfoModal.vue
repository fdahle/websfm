<script setup>
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { cloudInfo, rasterInfo } from '../../../core/products/productInfo.js'
import ModalShell from '../ui/ModalShell.vue'

// Right-click ▸ Show information on a sparse, dense or mesh cloud ({ cloudId }) or
// on a DEM / orthophoto ({ productId }). The rows are core/products/productInfo.js.
const props = defineProps({
  target: { type: Object, required: true },
})
const emit = defineEmits(['close'])

const recon = useReconstructionStore()
const { clouds, summary, rasterProducts } = storeToRefs(recon)
const { images } = storeToRefs(useImagesStore())

const cloud = computed(() =>
  props.target.cloudId ? (clouds.value.find((c) => c.id === props.target.cloudId) ?? null) : null,
)
const raster = computed(() =>
  props.target.productId ? (rasterProducts.value.find((p) => p.id === props.target.productId) ?? null) : null,
)

const info = computed(() => {
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

// The product was removed (or rebuilt away) while the dialog was open.
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

    <div v-if="raster?.previewUrl" class="preview">
      <img :src="raster.previewUrl" :alt="info.title" class="preview-img" />
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
