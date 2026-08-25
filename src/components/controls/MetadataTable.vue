<script setup>
import { formatFileSize } from '../../core/io/metadata.js'
import { useTableSort } from '../../composables/useTableSort.js'
import { useImagesStore } from '../../stores/useImagesStore.js'

// See ViewerImage: the thumbnail's @error routes here so a dead blob: URL is
// healed from OPFS, or the image is flagged, instead of rendering blank.
const imagesStore = useImagesStore()

const props = defineProps({
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

// Header-click sorting. Column key → comparable value on each image.
function metaVal(img, key) {
  const m = img.meta || {}
  switch (key) {
    case 'name':      return img.name?.toLowerCase() ?? ''
    case 'dimensions': return m.width ? m.width * (m.height || 1) : null
    case 'camera':    return m.model?.toLowerCase() ?? ''
    case 'focal':     return m.focalLength
    case 'aperture':  return m.fNumber
    case 'iso':       return m.iso
    case 'gps':       return m.gpsLat
    case 'keypoints': return img.kpStatus === 'done' ? img.kpCount : null
    case 'size':      return m.fileSize
    default:          return null
  }
}
const { toggleSort, sortArrow, sorted: sortedImages } = useTableSort(() => props.images, metaVal)
</script>

<template>
  <div class="table-wrap">
    <table v-if="images.length" v-col-resize>
      <thead>
        <tr>
          <th></th>
          <th class="sortable" @click="toggleSort('name')">Name <span class="arrow">{{ sortArrow('name') }}</span></th>
          <th class="sortable" @click="toggleSort('dimensions')">Dimensions <span class="arrow">{{ sortArrow('dimensions') }}</span></th>
          <th class="sortable" @click="toggleSort('camera')">Camera <span class="arrow">{{ sortArrow('camera') }}</span></th>
          <th class="sortable" @click="toggleSort('focal')">Focal <span class="arrow">{{ sortArrow('focal') }}</span></th>
          <th class="sortable" @click="toggleSort('aperture')">Aperture <span class="arrow">{{ sortArrow('aperture') }}</span></th>
          <th class="sortable" @click="toggleSort('iso')">ISO <span class="arrow">{{ sortArrow('iso') }}</span></th>
          <th class="sortable" @click="toggleSort('gps')">GPS <span class="arrow">{{ sortArrow('gps') }}</span></th>
          <th class="sortable" @click="toggleSort('keypoints')">Keypoints <span class="arrow">{{ sortArrow('keypoints') }}</span></th>
          <th class="sortable" @click="toggleSort('size')">Size <span class="arrow">{{ sortArrow('size') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="img in sortedImages"
          :key="img.id"
          :class="{ selected: img.id === selectedId }"
          @click="$emit('select', img.id)"
          @dblclick="$emit('open', img.id)"
        >
          <td class="thumb-cell">
            <img
              v-if="!img.previewPending && !img.previewFailed"
              :src="img.url"
              :alt="img.name"
              class="thumb"
              @error="imagesStore.reportImageLoadError(img.id)"
            />
            <div
              v-else-if="img.previewFailed"
              class="thumb thumb-error"
              :title="img.previewFailReason === 'source-lost'
                ? 'Image file no longer available — re-add the file'
                : 'Preview unavailable — decode failed'"
            >!</div>
            <div v-else class="thumb thumb-pending" title="Decoding image…" />
          </td>
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

thead th.sortable { cursor: pointer; user-select: none; }
thead th.sortable:hover { color: var(--text); }
.arrow { font-size: 9px; color: var(--accent); }

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

.thumb-pending {
  position: relative;
  overflow: hidden;
  background: linear-gradient(90deg, #000 25%, #222 37%, #000 63%);
  background-size: 400% 100%;
  animation: thumb-pending-shimmer 1.4s ease infinite;
}

@keyframes thumb-pending-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.thumb-error {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-weight: 600;
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
