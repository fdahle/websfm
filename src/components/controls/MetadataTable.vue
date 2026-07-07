<script setup>
import { formatFileSize } from '../../core/io/metadata.js'

defineProps({
  images: {
    type: Array,
    required: true,
  },
  selectedId: {
    type: String,
    default: null,
  },
})

defineEmits(['select', 'open'])

const round = (n, d = 1) => (n == null ? null : Number(n.toFixed(d)))
</script>

<template>
  <div class="table-wrap">
    <table v-if="images.length" v-col-resize>
      <thead>
        <tr>
          <th></th>
          <th>Name</th>
          <th>Dimensions</th>
          <th>Camera</th>
          <th>Focal</th>
          <th>Aperture</th>
          <th>ISO</th>
          <th>GPS</th>
          <th>Keypoints</th>
          <th>Size</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="img in images"
          :key="img.id"
          :class="{ selected: img.id === selectedId }"
          @click="$emit('select', img.id)"
          @dblclick="$emit('open', img.id)"
        >
          <td class="thumb-cell"><img :src="img.url" :alt="img.name" class="thumb" /></td>
          <td class="name-cell" :title="img.name">{{ img.name }}</td>

          <template v-if="img.loading || !img.meta">
            <td colspan="8" class="loading">reading…</td>
          </template>
          <template v-else>
            <td>
              <span v-if="img.meta.width">{{ img.meta.width }} × {{ img.meta.height }}</span>
              <span v-else class="na">—</span>
            </td>
            <td>{{ img.meta.model || '—' }}</td>
            <td :class="{ missing: img.meta.focalLength == null }">
              {{ img.meta.focalLength != null ? round(img.meta.focalLength) + ' mm' : 'missing' }}
            </td>
            <td>{{ img.meta.fNumber != null ? 'f/' + round(img.meta.fNumber) : '—' }}</td>
            <td>{{ img.meta.iso ?? '—' }}</td>
            <td :class="{ na: img.meta.gpsLat == null }">
              {{ img.meta.gpsLat != null ? `${round(img.meta.gpsLat, 5)}, ${round(img.meta.gpsLon, 5)}` : '—' }}
            </td>
            <td>
              <span v-if="img.kpStatus === 'running'" class="na">…</span>
              <span v-else-if="img.kpStatus === 'done'">{{ img.kpCount }}</span>
              <span v-else-if="img.kpStatus === 'error'" class="missing">error</span>
              <span v-else class="na">—</span>
            </td>
            <td>{{ formatFileSize(img.meta.fileSize) }}</td>
          </template>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty">Drop images in the sidebar to inspect their metadata.</div>
  </div>
</template>

<style scoped>
.table-wrap {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: var(--bg);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  text-align: left;
  padding: 10px 12px;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 1px solid var(--panel-border);
  white-space: nowrap;
}

tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
  white-space: nowrap;
}

tbody tr {
  cursor: pointer;
}

tbody tr:hover {
  background: rgba(255, 255, 255, 0.04);
}

tbody tr.selected {
  background: rgba(14, 99, 156, 0.25);
}

.thumb-cell {
  width: 48px;
}

.thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 4px;
  background: #000;
  display: block;
}

.name-cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.missing {
  color: #e55;
  font-style: italic;
}

.na,
.loading {
  color: var(--text-dim);
}

.empty {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}
</style>
