<script setup>
import { computed } from 'vue'
import { FIELD_DEFS } from '../../../core/io/metadata.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import ModalShell from '../ui/ModalShell.vue'

const props = defineProps({
  image: { type: Object, required: true },
})

// See ViewerImage: the <img>'s @error routes here so a dead blob: URL is healed
// from OPFS, or the image is flagged, instead of silently rendering blank.
const imagesStore = useImagesStore()

defineEmits(['close'])

const rows = computed(() => {
  const meta = props.image.meta
  return FIELD_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    important: def.important,
    value: meta ? def.format(meta) : null,
  }))
})

const gpsUrl = computed(() => {
  const m = props.image.meta
  if (!m || m.gpsLat == null || m.gpsLon == null) return null
  return `https://www.openstreetmap.org/?mlat=${m.gpsLat}&mlon=${m.gpsLon}#map=15/${m.gpsLat}/${m.gpsLon}`
})

// No Escape listener of its own: the global closer (composables/useModalEscape.js,
// `infoImageId`) dismisses this dialog in stacking order. A window listener here
// closed it on every Escape — even one meant for a dialog stacked above it.
// (ModalShell's own Escape handling only sees keys pressed inside this dialog.)
</script>

<template>
  <ModalShell :title="image.name" width="520px" flush @close="$emit('close')">
    <template #header>
      <span class="info-title" :title="image.name">{{ image.name }}</span>
    </template>

    <div class="preview">
      <img
        v-if="!image.previewPending && !image.previewFailed"
        :src="image.url"
        :alt="image.name"
        class="preview-img"
        @error="imagesStore.reportImageLoadError(image.id)"
      />
      <div v-else-if="image.previewFailed" class="preview-img preview-pending">
        {{
          image.previewFailReason === 'source-lost'
            ? 'Image file no longer available — re-add the file'
            : 'Preview unavailable — decode failed'
        }}
      </div>
      <div v-else class="preview-img preview-pending">Decoding image…</div>
    </div>

    <div v-if="image.kpStatus !== null" class="kp-bar">
      <span v-if="image.kpStatus === 'done'" class="kp-info">
        {{ image.kpCount }} keypoints · {{ image.kpMs }} ms
      </span>
      <span v-else-if="image.kpStatus === 'running'" class="kp-running">Detecting features…</span>
      <span v-else-if="image.kpStatus === 'error'" class="kp-error">Feature detection failed</span>
      <span v-else class="kp-none">No features detected yet</span>
    </div>

    <div v-if="image.loading" class="loading">Reading metadata…</div>

    <dl v-else class="meta">
      <template v-for="row in rows" :key="row.key">
        <dt>{{ row.label }}</dt>
        <dd v-if="row.value">{{ row.value }}</dd>
        <dd v-else-if="row.important" class="missing">missing</dd>
        <dd v-else class="na">—</dd>
      </template>
    </dl>

    <a v-if="gpsUrl" class="map-link" :href="gpsUrl" target="_blank" rel="noopener"> Open location in map ↗ </a>
  </ModalShell>
</template>

<style scoped>
/* #header replaces the shell's title: a smaller name that ellipsizes, kept clear
   of the close button. */
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

.preview-pending {
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 13px;
}

.kp-bar {
  padding: 8px 16px;
  border-bottom: 1px solid var(--panel-border);
  font-size: 12px;
}

.kp-info {
  color: var(--text-dim);
}
.kp-running {
  color: var(--text-dim);
  font-style: italic;
}
.kp-error {
  color: #e55;
}
.kp-none {
  color: var(--text-dim);
  font-style: italic;
}

.loading {
  padding: 20px 16px;
  color: var(--text-dim);
  font-size: 13px;
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

.meta dd.missing {
  color: #e55;
  font-style: italic;
}

.meta dd.na {
  color: var(--text-dim);
}

.map-link {
  display: block;
  margin: 0 16px 16px;
  font-size: 12px;
  color: var(--accent-hover);
  text-decoration: none;
}

.map-link:hover {
  text-decoration: underline;
}
</style>
