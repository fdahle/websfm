<script setup>
import { shiftRange } from '../../../core/verticalDatum.js'
import { ref, computed, watch } from 'vue'
import StatTiles from '../ui/StatTiles.vue'
import WarnBox from '../ui/WarnBox.vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { useQualityReport } from '../../../composables/useQualityReport.js'
import { differenceHistogram, differenceRange, differenceRgba } from '../../../core/eval/demCompare.js'
import { rdBuColor } from '../../../core/products/colormap.js'

// Quality Report ▸ Products: the computed DEM against an imported reference DEM
// (TODO.md ▸ A-6) — an area-wide, independent accuracy check, where DEM vs GCPs
// (Accuracy) is a handful of points. The numbers come from useQualityReport, so the
// exported report carries the same ones.
const recon = useReconstructionStore()
const external = useExternalStore()
const { demReferenceComparison, demReferenceTiles } = useQualityReport()

const refs = computed(() => external.demRasters)
const refId = ref(external.defaultDem?.id ?? refs.value[0]?.id ?? null)
watch(refs, (list) => {
  if (!list.some((r) => r.id === refId.value)) refId.value = list[0]?.id ?? null
})

const result = ref(null)
const error = ref('')
const loading = ref(false)
let runSeq = 0
async function run() {
  const seq = ++runSeq
  result.value = null
  error.value = ''
  if (!recon.dem || !refId.value) return
  loading.value = true
  try {
    const cmp = await demReferenceComparison(refId.value)
    if (seq === runSeq) result.value = cmp
  } catch (err) {
    if (seq === runSeq) error.value = err?.message ?? String(err)
  } finally {
    if (seq === runSeq) loading.value = false
  }
}
// The vertical offset is part of the cache key, so editing it in the raster's
// settings re-runs the comparison here too.
watch(() => [recon.dem, refId.value, external.rasterById(refId.value)?.vOffset], run, { immediate: true })

const tiles = computed(() => demReferenceTiles(result.value))
const unit = computed(() => result.value?.demUnit ?? '')
const range = computed(() => differenceRange(result.value?.stats))
const fmt = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toPrecision(3)}`

// Difference map: the comparison sub-grid on a diverging ramp centred on zero.
const mapUrl = computed(() => {
  const r = result.value
  if (!r?.compared || typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = r.width
  canvas.height = r.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(differenceRgba(r, range.value, rdBuColor), r.width, r.height), 0, 0)
  return canvas.toDataURL('image/png')
})
const legendGradient = computed(
  () => `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `rgb(${rdBuColor(t).join(',')})`).join(', ')})`,
)

// Histogram over the 2nd–98th percentile (padded). Bars in the accent colour, not
// the map's ramp: its centre is near-white and would vanish on a light theme.
const hist = computed(() => {
  const s = result.value?.stats
  if (!s) return null
  // A floor on the span keeps a near-constant difference a spike, not 40 bins of
  // float noise between two identical labels.
  const half = 0.6 * Math.max(s.q98 - s.q02, 0.01)
  const mid = (s.q02 + s.q98) / 2
  const h = differenceHistogram(result.value.diff, mid - half, mid + half, 40)
  const peak = Math.max(1, ...h.counts)
  const pos = (v) => ((v - h.lo) / (h.hi - h.lo)) * 100
  return {
    ...h,
    bars: h.counts.map((n, i) => ({ height: (n / peak) * 100, n, centre: h.lo + (i + 0.5) * h.binWidth })),
    zeroAt: h.lo <= 0 && h.hi >= 0 ? pos(0) : null,
    medianAt: pos(s.median),
  }
})
</script>

<template>
  <div class="sec-title">DEM vs reference DEM</div>

  <div v-if="!recon.dem" class="eval-loading">Build a DEM first.</div>
  <div v-else-if="!refs.length" class="eval-loading">
    No reference DEM in the project — import one from Import ▸ Reference DEM / Ortho.
  </div>
  <template v-else>
    <div class="ref-row">
      <label class="field-label" for="eval-ref-dem">Reference</label>
      <select v-if="refs.length > 1" id="eval-ref-dem" v-model="refId" class="field-select">
        <option v-for="r in refs" :key="r.id" :value="r.id">{{ r.name }}</option>
      </select>
      <span v-else id="eval-ref-dem" class="ref-name">{{ refs[0].name }}</span>
      <span v-if="result" class="ref-meta">
        datum {{ result.reference.datum }}
        <template v-if="result.reference.accuracy != null"> · σ {{ result.reference.accuracy }}</template>
        <template v-if="result.reference.vOffset"> · offset {{ fmt(result.reference.vOffset) }}</template>
        <template v-if="result.reference.conversion">
          · converted to {{ result.reference.conversion.to }} ({{ shiftRange(result.reference.conversion) }})</template
        >
      </span>
    </div>

    <div v-if="loading" class="eval-loading">Comparing…</div>
    <WarnBox v-else-if="error">{{ error }}</WarnBox>
    <div v-else-if="result && !result.compared" class="eval-loading">
      The DEM and the reference do not overlap — check that both are in the CRS they declare.
    </div>
    <template v-else-if="result">
      <StatTiles :tiles="tiles" />
      <WarnBox v-for="w in result.warnings" :key="w">{{ w }}</WarnBox>

      <div class="viz">
        <figure class="viz-map">
          <figcaption class="viz-title">Difference map</figcaption>
          <img
            v-if="mapUrl"
            :src="mapUrl"
            alt="DEM minus reference, blue below and red above"
            :style="{ aspectRatio: `${result.width} / ${result.height}` }"
          />
          <div class="legend-bar" :style="{ background: legendGradient }"></div>
          <div class="legend-labels">
            <span>{{ fmt(-range) }}</span
            ><span>0</span><span>{{ fmt(range) }} {{ unit }}</span>
          </div>
          <div class="viz-foot">Blue: DEM below the reference · red: above · grey: no reference height</div>
        </figure>

        <figure v-if="hist" class="viz-hist">
          <figcaption class="viz-title">Distribution of ΔZ</figcaption>
          <div class="hist-plot">
            <div
              v-for="(b, i) in hist.bars"
              :key="i"
              class="hist-col"
              :title="`${fmt(b.centre)} ${unit}: ${b.n.toLocaleString()} cells`"
            >
              <div class="hist-bar" :style="{ height: b.height + '%' }"></div>
            </div>
            <div v-if="hist.zeroAt != null" class="hist-mark zero" :style="{ left: hist.zeroAt + '%' }"></div>
            <div class="hist-mark median" :style="{ left: hist.medianAt + '%' }" title="median"></div>
          </div>
          <div class="legend-labels">
            <span>{{ fmt(hist.lo) }}</span
            ><span>{{ fmt(hist.hi) }} {{ unit }}</span>
          </div>
          <div class="viz-foot">
            Dashed: zero · solid: median.
            <template v-if="hist.below || hist.above">
              {{ (hist.below + hist.above).toLocaleString() }} cells beyond the plotted range.
            </template>
          </div>
        </figure>
      </div>

      <p class="eval-note">
        ΔZ = DEM − reference at each DEM cell the reference covers<template v-if="result.step > 1">
          (every {{ result.step }}th cell each way)</template
        >; the reference is sampled bilinearly in its own CRS. Median and NMAD describe the bulk and ignore blunders
        (water, shadow, vegetation edges); RMSE does not. A bias that grows with slope points to a horizontal shift
        between the two DEMs rather than a vertical one.
      </p>
    </template>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.sec-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.eval-loading {
  padding: 24px;
  text-align: center;
  color: var(--text-dim);
}
.eval-note {
  font-size: 11px;
  color: var(--text-dim);
  margin: 2px 0 0;
}
.ref-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ref-name {
  font-size: 13px;
  color: var(--text);
}
.ref-meta {
  font-size: 11px;
  color: var(--text-dim);
}
.viz {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}
figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.viz-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.viz-map img {
  width: 100%;
  max-height: 300px;
  object-fit: contain;
  image-rendering: pixelated;
}
.legend-bar {
  height: 8px;
  border-radius: 3px;
}
.legend-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.viz-foot {
  font-size: 10px;
  color: var(--text-dim);
}
.hist-plot {
  position: relative;
  height: 160px;
  display: flex;
  align-items: flex-end;
  gap: 1px;
  border-bottom: 1px solid var(--panel-border);
}
.hist-col {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.hist-bar {
  width: 100%;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
}
.hist-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  pointer-events: auto;
}
.hist-mark.zero {
  border-left: 1px dashed var(--text-dim);
}
.hist-mark.median {
  border-left: 2px solid var(--text);
}
</style>
