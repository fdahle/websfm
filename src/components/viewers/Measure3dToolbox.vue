<script setup>
// The toolbox of Tools ▸ Measure ▸ Measure in 3D, over the 3D view (Viewer3D.vue).
// `m` is the measuring state and its actions (useMeasure3d.js), as one reactive object;
// the toolbox only shows them and calls them.
import FloatingToolbox from './FloatingToolbox.vue'
import I18nText from '../I18nText.vue'
import { keyLabel } from '../../utils/shortcutLabels.js'
import { useI18n } from '../../composables/useI18n.js'

defineProps({ m: { type: Object, required: true } })
const emit = defineEmits(['command'])
const { t, tx } = useI18n()
const KINDS = ['distance', 'polyline', 'area']
</script>

<template>
  <FloatingToolbox
    id="measure-3d"
    :title="t('view3d.measure.title')"
    anchor="top-center"
    :width="300"
    :close-title="t('view3d.measure.close')"
    close-key="measure3d.clear"
    @close="m.exitMeasure()"
  >
    <div class="tb-row" role="group" :aria-label="t('view3d.measure.kinds')">
      <button
        v-for="kind in KINDS"
        :key="kind"
        class="tb-textbtn"
        :class="{ active: m.measureTool === kind }"
        :aria-pressed="m.measureTool === kind"
        @click="m.chooseMeasureTool(kind)"
      >
        {{ t(`view3d.measure.${kind}`) }}
      </button>
    </div>
    <template v-if="m.measureResult?.line">
      <div class="tb-line">
        <span class="tb-count">{{ m.fmt(m.measureResult.line.length, m.measureResult.units) }}</span>
        <template v-if="m.measureResult.line.segments.length > 1">
          {{ t('view3d.measure.overSegments', { n: m.measureResult.line.segments.length }) }}
        </template>
      </div>
      <div class="tb-hint">
        {{
          t('view3d.measure.lineDetail', {
            horizontal: m.fmt(m.measureResult.line.horizontal, m.measureResult.units),
            vertical: m.fmt(m.measureResult.line.vertical, m.measureResult.units),
          })
        }}
      </div>
    </template>
    <template v-else-if="m.measureResult?.area">
      <div class="tb-line">
        <I18nText
          k="view3d.measure.surfaceArea"
          :params="{ area: m.fmt(m.measureResult.area.area, m.measureResult.units, 2) }"
        >
          <template #count="{ text }">
            <span class="tb-count">{{ text }}</span>
          </template>
        </I18nText>
      </div>
      <div class="tb-hint">
        {{
          t('view3d.measure.areaDetail', {
            footprint: m.fmt(m.measureResult.area.footprint, m.measureResult.units, 2),
            perimeter: m.fmt(m.measureResult.area.perimeter, m.measureResult.units),
          })
        }}<template v-if="m.measureResult.area.planarity > 0.02 * m.measureResult.area.perimeter">{{
          t('view3d.measure.notFlat')
        }}</template>
      </div>
    </template>
    <div v-else class="tb-hint">
      {{
        m.measureTool === 'distance'
          ? t('view3d.measure.hintDistance', { undo: keyLabel('measure3d.undo'), clear: keyLabel('measure3d.clear') })
          : t('view3d.measure.hintMulti', {
              finish: keyLabel('measure3d.finish'),
              undo: keyLabel('measure3d.undo'),
              clear: keyLabel('measure3d.clear'),
            })
      }}
    </div>
    <div v-if="m.measureNote" class="tb-hint warn">{{ tx(m.measureNote) }}</div>
    <div v-if="m.measureResult" class="tb-row">
      <button
        class="tb-textbtn"
        :disabled="!m.measureDone"
        :title="t(m.measureDone ? 'view3d.measure.saveTitle' : 'view3d.measure.saveFirst')"
        @click="m.saveMeasure()"
      >
        {{ t('view3d.measure.save') }}
      </button>
      <button v-if="!m.measureDone && m.measureTool !== 'distance'" class="tb-textbtn" @click="m.finishMeasure()">
        {{ t('view3d.measure.finish') }}
      </button>
      <button
        class="tb-textbtn"
        :title="t('view3d.measure.clearTitle', { key: keyLabel('measure3d.clear') })"
        @click="m.clearMeasure()"
      >
        {{ t('view3d.measure.clear') }}
      </button>
    </div>
    <template v-if="m.saved3d.length">
      <div class="tb-hint tb-row">
        {{ t('view3d.measure.saved') }}
        <button
          class="tb-textbtn"
          :title="t('view3d.measure.exportTitle')"
          @click="
            emit('command', 'export-measurements', {
              ids: m.saved3d.map((r) => r.id),
              label: t('view3d.measure.exportLabel', { n: m.saved3d.length }),
            })
          "
        >
          {{ t('view3d.measure.export') }}
        </button>
      </div>
      <div v-for="r in m.saved3d" :key="r.id" class="tb-line saved-measure">
        <span :title="r.cloudName ? t('view3d.measure.measuredOn', { name: r.cloudName }) : ''">{{ r.name }}</span>
        <span
          >{{ m.savedValue(r) }}<template v-if="m.savedStale(r)">{{ t('view3d.measure.layerChanged') }}</template></span
        >
        <button
          class="tb-textbtn danger"
          :aria-label="t('view3d.measure.remove', { name: r.name })"
          @click="m.measurementsStore.remove(r.id)"
        >
          ×
        </button>
      </div>
    </template>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.tb-textbtn.active {
  background: rgba(14, 99, 156, 0.25);
  border-color: var(--accent);
}
.tb-hint.warn {
  color: #e0a040;
  margin-top: 4px;
}
.saved-measure {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 6px;
  align-items: center;
  margin: 2px 0 0;
}
.saved-measure span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
