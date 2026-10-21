<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useImagesStore } from '../../stores/useImagesStore.js'

// A list/table/grid thumbnail of a source image (TODO ▸ SC-8). Shows `image.thumb`
// — the ≤256 px JPEG from useImagesStore — never the full-resolution `image.url`,
// which stays for the image viewer. A missing thumbnail (an older project, an image
// still being ingested) is requested only once this element is near the viewport,
// so a 5,000-row grid decodes the rows you look at, not the whole project.
//
// Failure handling: a thumbnail <img> that fails to load calls
// `reportThumbnailError` (drop + regenerate once from the display source) — the
// thumbnail's counterpart of the `reportImageLoadError` every full-image <img>
// carries. A failed source decode shows the error placeholder.
//
// Size it from the parent with a class (it is a block element; the image covers it).
const props = defineProps({
  image: { type: Object, required: true },
  alt: { type: String, default: null },
})

const imagesStore = useImagesStore()
const root = ref(null)
const nearView = ref(false)
let io = null

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !root.value) {
    nearView.value = true
    return
  }
  io = new IntersectionObserver(
    (entries) => {
      nearView.value = entries.some((e) => e.isIntersecting)
    },
    { rootMargin: '200px' },
  )
  io.observe(root.value)
})
onBeforeUnmount(() => io?.disconnect())

// Ask whenever it is in view without a thumbnail — including after the source
// changes (a TIFF's display JPEG lands, a healed URL).
watch(
  [nearView, () => props.image.thumb, () => props.image.url, () => props.image.previewPending],
  ([visible, thumb]) => {
    if (visible && !thumb && !props.image.previewFailed) imagesStore.requestThumbnail(props.image, { urgent: true })
  },
  { immediate: true },
)

const src = computed(() => (props.image.previewFailed ? null : (props.image.thumb?.url ?? null)))
const failTitle = computed(() =>
  props.image.previewFailReason === 'source-lost'
    ? 'Image file no longer available — re-add the file'
    : 'Preview unavailable — decode failed',
)
</script>

<template>
  <span
    ref="root"
    class="image-thumb"
    :class="{ pending: !src && !image.previewFailed, failed: image.previewFailed }"
    :title="image.previewFailed ? failTitle : null"
  >
    <img
      v-if="src"
      :src="src"
      :alt="alt ?? image.name"
      decoding="async"
      draggable="false"
      @error="imagesStore.reportThumbnailError(image.id)"
    />
    <template v-else-if="image.previewFailed">!</template>
  </span>
</template>

<style scoped>
.image-thumb {
  display: block;
  position: relative;
  overflow: hidden;
  background: #000;
}
.image-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.image-thumb.pending {
  background: linear-gradient(90deg, #000 25%, #222 37%, #000 63%);
  background-size: 400% 100%;
  animation: image-thumb-shimmer 1.4s ease infinite;
}
.image-thumb.failed {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-weight: 600;
}
@keyframes image-thumb-shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}
</style>
