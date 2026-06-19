<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { FIELD_DEFS } from '../utils/metadata.js'

const props = defineProps({
  image: { type: Object, required: true },
})

const emit = defineEmits(['close', 'detect'])

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

function onKey(e) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title" :title="image.name">{{ image.name }}</span>
        <button class="modal-close" title="Close" @click="$emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="preview">
          <img :src="image.url" :alt="image.name" class="preview-img" />
        </div>

        <div class="sift-bar">
          <button
            class="detect-btn"
            :disabled="image.kpStatus === 'running'"
            @click="$emit('detect', image.id)"
          >
            {{ image.kpStatus === 'running' ? 'Detecting…' : 'Detect SIFT' }}
          </button>
          <span v-if="image.kpStatus === 'done'" class="sift-info">
            {{ image.kpCount }} keypoints · {{ image.kpMs }} ms
          </span>
          <span v-else-if="image.kpStatus === 'error'" class="sift-error">detection failed</span>
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

        <a v-if="gpsUrl" class="map-link" :href="gpsUrl" target="_blank" rel="noopener">
          Open location in map ↗
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 520px;
  max-width: 92vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}

.modal-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 5px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.modal-body {
  overflow-y: auto;
  flex: 1;
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

.sift-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.detect-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 5px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  font: inherit;
}

.detect-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.detect-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.sift-info {
  font-size: 12px;
  color: var(--text-dim);
}

.sift-error {
  font-size: 12px;
  color: #e55;
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
