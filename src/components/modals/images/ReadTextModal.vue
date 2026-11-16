<script setup>
import { computed } from 'vue'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import ModalShell from '../ui/ModalShell.vue'
import I18nText from '../../I18nText.vue'
import ExperimentalBadge from '../../layout/ExperimentalBadge.vue'
import { useI18n } from '../../../composables/useI18n.js'
import { useTextMask } from '../../../composables/useTextMask.js'
import { storedToLines } from '../../../core/ocr/textRun.js'
import { isSureText } from '../../../core/ocr/textMask.js'
import { photoValues, voteValue } from '../../../core/ocr/values.js'

// Read text: the text on the photos (core/ocr/, read once per photo and kept on its
// record), per photo, and the values a camera's photos print (core/ocr/values.js): the
// focal length, which a film camera can take over, and the date. Auto Mask ▸ Text
// masks the same lines.
const emit = defineEmits(['close'])

const imagesStore = useImagesStore()
const sensorsStore = useSensorsStore()
const { t } = useI18n()
const reader = useTextMask()

const images = computed(() => imagesStore.images)
const unread = computed(() => images.value.filter((img) => !imagesStore.hasPhotoText(img)))
const readCount = computed(() => images.value.length - unread.value.length)
const lineCount = computed(() =>
  images.value.reduce((n, img) => n + (imagesStore.hasPhotoText(img) ? img.textLines.lines.length : 0), 0),
)

const readReason = computed(() =>
  reader.busy.value
    ? t('readText.disabled.busy')
    : !images.value.length
      ? t('readText.disabled.noImages')
      : !unread.value.length
        ? t('readText.disabled.allRead')
        : null,
)
const againReason = computed(() =>
  reader.busy.value ? t('readText.disabled.busy') : !images.value.length ? t('readText.disabled.noImages') : null,
)

const readUnread = () => reader.readText(unread.value)
const readAll = () => reader.readText(images.value, { force: true })

// Per camera: the focal length and date its read photos agree on.
const cameras = computed(() => {
  const groups = new Map()
  for (const img of images.value) {
    if (!imagesStore.hasPhotoText(img)) continue
    const key = img.sensorId ?? null
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(photoValues(storedToLines(img.textLines.lines)))
  }
  return [...groups].map(([id, photos]) => {
    const sensor = sensorsStore.sensors.find((s) => s.id === id) ?? null
    const focal = voteValue(photos.map((p) => p.focal))
    const date = voteValue(photos.map((p) => p.date))
    const currentMm = sensor?.focalUnit === 'mm' && sensor.focal > 0 ? sensor.focal : null
    return { id, sensor, focal, date, currentMm }
  })
})

function useFocal(cam) {
  sensorsStore.updateSensor(cam.sensor.id, 'focalMm', Number(cam.focal.value))
}
const sameFocal = (cam) => cam.currentMm != null && Math.abs(cam.currentMm - Number(cam.focal.value)) < 1e-6

// Per photo: its lines, the sure ones first.
const rows = computed(() =>
  images.value.map((img) => {
    if (!imagesStore.hasPhotoText(img)) return { img, lines: null }
    const lines = storedToLines(img.textLines.lines)
      .map((l) => ({ text: l.text, score: l.textScore, sure: isSureText(l) }))
      .sort((a, b) => Number(b.sure) - Number(a.sure) || b.score - a.score)
    return { img, lines }
  }),
)
</script>

<template>
  <ModalShell class="read-text" :title="t('readText.title')" width="680px" flush :scroll="false" @close="emit('close')">
    <div class="controls">
      <p class="intro"><I18nText k="readText.intro" /> <ExperimentalBadge id="textMask" /></p>
      <div class="actions">
        <button class="btn" :disabled="!!readReason" :title="readReason" @click="readUnread">
          {{ t('readText.read', { n: unread.length }) }}
        </button>
        <button class="btn ghost" :disabled="!!againReason" :title="againReason" @click="readAll">
          {{ t('readText.readAgain') }}
        </button>
        <template v-if="reader.busy.value">
          <span class="hint progress">{{
            reader.progress.value ? t('readText.progress', reader.progress.value) : ''
          }}</span>
          <button class="btn ghost sm" @click="reader.cancel">{{ t('readText.cancel') }}</button>
        </template>
        <span v-else class="hint">{{
          t('readText.status', { read: readCount, n: images.length, lines: lineCount })
        }}</span>
      </div>
    </div>

    <div v-if="cameras.length" class="cameras">
      <div v-for="cam in cameras" :key="cam.id ?? '-'" class="camera">
        <div class="camera-name">{{ cam.sensor?.label ?? '—' }}</div>
        <div class="value">
          <span class="value-label">{{ t('readText.camera.focal') }}</span>
          <template v-if="cam.focal">
            <span>{{
              t('readText.camera.onPhotos', {
                value: t('readText.camera.focalValue', { mm: Number(cam.focal.value) }),
                photos: cam.focal.photos,
                of: cam.focal.of,
              })
            }}</span>
            <span v-if="cam.sensor?.kind === 'film'" class="dim">{{
              cam.currentMm != null
                ? t('readText.camera.current', { mm: cam.currentMm })
                : t('readText.camera.currentNone')
            }}</span>
            <button
              v-if="cam.sensor?.kind === 'film'"
              class="btn sm"
              :disabled="sameFocal(cam)"
              :title="sameFocal(cam) ? t('readText.camera.same') : null"
              @click="useFocal(cam)"
            >
              {{ t('readText.camera.use', { mm: Number(cam.focal.value) }) }}
            </button>
          </template>
          <span v-else class="dim">{{ t('readText.camera.none') }}</span>
        </div>
        <div class="value">
          <span class="value-label">{{ t('readText.camera.date') }}</span>
          <span v-if="cam.date">{{
            t('readText.camera.onPhotos', { value: cam.date.value, photos: cam.date.photos, of: cam.date.of })
          }}</span>
          <span v-else class="dim">{{ t('readText.camera.none') }}</span>
        </div>
      </div>
    </div>

    <div class="list">
      <table>
        <thead>
          <tr>
            <th>{{ t('readText.photo') }}</th>
            <th>{{ t('readText.text') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.img.id">
            <td class="name">{{ r.img.name }}</td>
            <td>
              <span v-if="!r.lines" class="dim">{{ t('readText.unread') }}</span>
              <span v-else-if="!r.lines.length" class="dim">{{ t('readText.noText') }}</span>
              <span
                v-for="(l, i) in r.lines"
                v-else
                :key="i"
                class="line"
                :class="{ sure: l.sure }"
                :title="l.score.toFixed(2)"
                >{{ l.text }}</span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </ModalShell>
</template>

<style scoped>
.controls {
  padding: 12px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.intro {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-dim);
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hint {
  font-size: 11px;
  color: var(--text-dim);
}
.progress {
  font-variant-numeric: tabular-nums;
}
.cameras {
  padding: 8px 16px;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.camera-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.value {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
  margin-top: 3px;
}
.value-label {
  color: var(--text-dim);
  min-width: 120px;
}
.dim {
  color: var(--text-dim);
}
.list {
  flex: 1;
  overflow: auto;
  min-height: 0;
  background: var(--bg);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th {
  position: sticky;
  top: 0;
  background: var(--panel);
  text-align: left;
  font-weight: 600;
  color: var(--text-dim);
  padding: 6px 16px;
  border-bottom: 1px solid var(--panel-border);
}
td {
  padding: 5px 16px;
  border-bottom: 1px solid var(--panel-border);
  vertical-align: top;
  color: var(--text);
}
.name {
  white-space: nowrap;
}
.line {
  display: inline-block;
  margin: 0 8px 2px 0;
  color: var(--text-dim);
}
.line.sure {
  color: var(--text);
  font-weight: 600;
}
.btn {
  background: var(--accent);
  border: none;
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 5px;
  cursor: pointer;
}
.btn.ghost {
  background: transparent;
  border: 1px solid var(--panel-border);
  color: var(--text);
}
.btn.sm {
  font-size: 11px;
  padding: 4px 9px;
}
.btn:hover:not(:disabled) {
  filter: brightness(1.1);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
