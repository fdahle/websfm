<script setup>
import { computed } from 'vue'
import { FIELD_DEFS } from '../utils/metadata.js'
import KeypointOverlay from './KeypointOverlay.vue'

const props = defineProps({
  image: {
    type: Object,
    required: true,
  },
})

defineEmits(['close', 'detect'])

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
</script>

<template>
  <div class="panel">
    <header class="panel-header">
      <span class="title" :title="image.name">{{ image.name }}</span>
      <button class="close" title="Close" @click="$emit('close')">×</button>
    </header>

    <div class="preview">
      <KeypointOverlay :url="image.url" :keypoints="image.keypoints" />
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

    <a v-if="gpsUrl" class="map-link" :href="gpsUrl" target="_blank" rel="noopener">Open location in map ↗</a>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 320px;
  background: var(--panel);
  border-left: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.3);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--panel-border);
  position: sticky;
  top: 0;
  background: var(--panel);
}

.title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.close:hover {
  color: var(--text);
}

.preview {
  width: 100%;
  background: #000;
  flex-shrink: 0;
  text-align: center;
}

.sift-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--panel-border);
}

.detect-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
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
  padding: 20px 14px;
  color: var(--text-dim);
  font-size: 13px;
}

.meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  padding: 14px;
  font-size: 13px;
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
  margin: 0 14px 16px;
  font-size: 13px;
  color: var(--accent-hover);
  text-decoration: none;
}

.map-link:hover {
  text-decoration: underline;
}
</style>
