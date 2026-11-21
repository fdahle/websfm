<script setup>
import { computed } from 'vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import { estimatedIntrinsics } from '../../../core/sfm/cameraEstimated.js'
import { resolveK } from '../../../core/sfm/reconstruction.js'
import { radialCurve, focalDelta } from '../../../core/eval/calibration.js'
import { EVAL_THRESHOLDS } from '../../../core/eval/health.js'
import { FOCAL_UNFIXED_SHARE, focalSigmaShare, focalSigmaPct } from '../../../core/sfm/focalSigma.js'
import { useI18n } from '../../../composables/useI18n.js'
import I18nText from '../../I18nText.vue'

// Quality Report ▸ Calibration: per camera group the BA-refined focal vs nominal, the lens
// the main model was solved with (its own calibration, displayFrame.js
// calibrationSnapshot) and a Δr(r) curve of its radial part. A model from before the lens
// was solved whole shows its self-cal correction and that correction's fit health.
// Thresholds come from the shared EVAL_THRESHOLDS table (WS2.6). A group whose focal the
// run found weakly fixed by survey-grade positions over a flat nadir block carries
// `focalHeight` (core/sfm/focalHeight.js, displayFrame.js withFocalHeight).
const { t } = useI18n()
const recon = useReconstructionStore()
const imagesStore = useImagesStore()
const sensorsStore = useSensorsStore()

const FIT_RMS_WARN = EVAL_THRESHOLDS.selfCalFitRmsPx.warn
const FOCAL_WARN = EVAL_THRESHOLDS.focalDeltaPct.warn

const own = computed(() => recon.mainSparseCloud?.calibration ?? null)
// Per sensor: { k1…, p1, p2 (or a fisheye's k4), whole, fitRmsPx? }. `whole`: the lens
// itself; otherwise a correction on top of the sensor's lens (an older model).
const distBySensor = computed(() => {
  const m = new Map()
  if (own.value) {
    for (const g of own.value.groups ?? []) {
      if (g.sensorId == null) continue
      if (g.selfCal) m.set(g.sensorId, { ...g.selfCal, whole: false })
      else if (g.dist) m.set(g.sensorId, { ...g.dist, whole: true })
    }
    return m
  }
  for (const d of recon.summary?.selfCalDistortion ?? []) m.set(d.sensorId, { ...d, whole: !!d.full })
  return m
})
const selfCalWasOff = computed(() => !own.value && (recon.summary?.selfCalDistortion?.length ?? 0) === 0)
const notRecorded = computed(() => own.value?.source === 'not-recorded')

const rows = computed(() => {
  const cameras = recon.sparseCameras
  return sensorsStore.sensors
    .map((sensor) => {
      const imgs = imagesStore.images.filter((im) => im.sensorId === sensor.id)
      const cams = imgs.map((im) => cameras.get(im.uuid)).filter(Boolean)
      const fxs = cams.map((c) => estimatedIntrinsics(c)?.focal).filter((v) => v != null)
      const refinedFx = fxs.length ? fxs.reduce((a, b) => a + b, 0) / fxs.length : null
      const rep = imgs.find((im) => im.meta) ?? imgs[0]
      const nominal = rep ? resolveK(rep.meta ?? {}, sensor) : null
      const nominalFx = nominal?.fx ?? null
      const delta = focalDelta(refinedFx, nominalFx)
      const dist = distBySensor.value.get(sensor.id) ?? null
      const w = sensor.width || rep?.meta?.width || 0
      const h = sensor.height || rep?.meta?.height || 0
      const rMax = refinedFx && w && h ? Math.hypot(w / 2, h / 2) / refinedFx : 1
      const curve = dist ? radialCurve(dist, rMax, 40) : []
      // How well the solve fixed the focal (bundle.rs ▸ lens σ); heights move with it.
      const focalSigma = own.value?.groups?.find((g) => g.sensorId === sensor.id)?.focalSigmaPx ?? null
      const sigmaShare = focalSigmaShare(refinedFx, focalSigma)
      const focalHeight = own.value?.groups?.find((g) => g.sensorId === sensor.id)?.focalHeight ?? null
      return {
        id: sensor.id,
        label: sensor.label,
        nCams: cams.length,
        refinedFx,
        focalSigma,
        sigmaShare,
        focalHeight,
        nominalFx,
        delta,
        dist,
        curve,
        rMax,
      }
    })
    .filter((r) => r.nCams > 0 || r.dist)
})

const num = (key, v) => (v == null ? '—' : t(key, { v }))
// The focal σ as a percentage, rounded as the log writes it (focalSigma.js).
const sigmaPct = (share) => Number(focalSigmaPct(share))
const BROWN = ['k1', 'k2', 'k3']
const DECENTRING = ['p1', 'p2']

function polyline(curve) {
  if (!curve.length) return ''
  const W = 200,
    H = 70,
    pad = 4
  const rMax = curve[curve.length - 1].r || 1
  const drs = curve.map((p) => p.dr)
  const maxAbs = Math.max(1e-9, ...drs.map((v) => Math.abs(v)))
  const x = (r) => pad + (r / rMax) * (W - 2 * pad)
  const y = (dr) => H / 2 - (dr / maxAbs) * (H / 2 - pad)
  return curve.map((p) => `${x(p.r).toFixed(1)},${y(p.dr).toFixed(1)}`).join(' ')
}
const drAtEdge = (curve) => (curve.length ? curve[curve.length - 1].dr : null)
</script>

<template>
  <div v-if="!rows.length" class="eval-loading">{{ t('quality.calibration.noSensors') }}</div>
  <template v-else>
    <div v-if="selfCalWasOff" class="warn-box">{{ t('quality.calibration.selfCalOff') }}</div>
    <div v-if="notRecorded" class="warn-box">{{ t('quality.calibration.notRecorded') }}</div>

    <div v-for="s in rows" :key="s.id" class="sensor-card">
      <div class="sensor-head">
        <span class="sensor-label">{{ s.label }}</span>
        <span class="sensor-cams">{{ t('quality.calibration.cameras', { n: s.nCams }) }}</span>
      </div>

      <div class="cal-grid">
        <div class="cal-item">
          <div class="cal-k">{{ t('quality.calibration.refinedFx') }}</div>
          <div class="cal-v">
            {{
              s.refinedFx != null && s.focalSigma != null
                ? t('quality.calibration.fxSigma', { v: s.refinedFx, s: s.focalSigma })
                : num('quality.calibration.fxValue', s.refinedFx)
            }}
            <span class="unit">px</span>
          </div>
        </div>
        <div class="cal-item">
          <div class="cal-k">{{ t('quality.calibration.nominalFx') }}</div>
          <div class="cal-v">{{ num('quality.calibration.fxValue', s.nominalFx) }} <span class="unit">px</span></div>
        </div>
        <div class="cal-item">
          <div class="cal-k">
            {{ t('quality.calibration.focalDelta') }}
            <span class="unit">({{ t('quality.threshold.aboveAbs', { warn: FOCAL_WARN, unit: '%' }) }})</span>
          </div>
          <div class="cal-v" :class="{ warn: s.delta.deltaPct != null && Math.abs(s.delta.deltaPct) > FOCAL_WARN }">
            {{ num('quality.calibration.deltaPx', s.delta.deltaPx) }}
            <span v-if="s.delta.deltaPct != null" class="unit">{{
              t('quality.calibration.deltaPct', { v: s.delta.deltaPct })
            }}</span>
          </div>
        </div>
      </div>

      <div v-if="s.focalHeight" class="warn-box">
        <I18nText
          k="quality.calibration.focalHeight"
          :params="{
            spread: s.focalHeight.spreadM,
            height: s.focalHeight.flyingHeightM,
            ratio: 100 * s.focalHeight.ratio,
            cm: 100 * s.focalHeight.heightPer0_01PctM,
          }"
        />
      </div>
      <div v-if="s.sigmaShare != null && s.sigmaShare >= FOCAL_UNFIXED_SHARE" class="warn-box">
        {{ t('quality.calibration.focalUnfixed', { pct: sigmaPct(s.sigmaShare) }) }}
      </div>
      <div v-else-if="s.sigmaShare != null" class="cal-note">
        {{ t('quality.calibration.focalSigmaNote', { pct: sigmaPct(s.sigmaShare) }) }}
      </div>

      <template v-if="s.dist">
        <div class="cal-grid">
          <div v-for="k in BROWN" :key="k" class="cal-item">
            <div class="cal-k">{{ k }}</div>
            <div class="cal-v">{{ num('quality.calibration.term', s.dist[k]) }}</div>
          </div>
          <div v-if="s.dist.fisheye" class="cal-item">
            <div class="cal-k">{{ 'k4' }}</div>
            <div class="cal-v">{{ num('quality.calibration.term', s.dist.k4) }}</div>
          </div>
          <template v-if="s.dist.p1 || s.dist.p2">
            <div v-for="k in DECENTRING" :key="k" class="cal-item">
              <div class="cal-k">{{ k }}</div>
              <div class="cal-v">{{ num('quality.calibration.termP', s.dist[k]) }}</div>
            </div>
          </template>
          <div v-if="!s.dist.whole && s.dist.fitRmsPx != null" class="cal-item">
            <div class="cal-k">
              {{ t('quality.calibration.fitRms') }}
              <span class="unit">({{ t('quality.threshold.above', { warn: FIT_RMS_WARN, unit: 'px' }) }})</span>
            </div>
            <div class="cal-v" :class="{ warn: s.dist.fitRmsPx > FIT_RMS_WARN }">
              {{ num('quality.calibration.fitRmsValue', s.dist.fitRmsPx) }}
            </div>
          </div>
        </div>

        <div class="curve-wrap">
          <svg viewBox="0 0 200 70" class="curve" preserveAspectRatio="none">
            <line x1="4" y1="35" x2="196" y2="35" class="curve-axis" />
            <polyline :points="polyline(s.curve)" class="curve-line" />
          </svg>
          <div class="curve-cap">
            {{ t('quality.calibration.curve', { dr: drAtEdge(s.curve) ?? 0, r: s.rMax }) }}
          </div>
        </div>
      </template>
      <div v-else class="cal-empty">{{ t('quality.calibration.noLens') }}</div>
    </div>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading {
  padding: 24px;
  text-align: center;
  color: var(--text-dim);
}
.sensor-card {
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sensor-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.sensor-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.cal-note {
  font-size: 11px;
  color: var(--text-dim);
}
.sensor-cams {
  font-size: 11px;
  color: var(--text-dim);
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 8px;
}
.cal-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cal-k {
  font-size: 11px;
  color: var(--text-dim);
}
.cal-v {
  font-size: 14px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.cal-v.warn {
  color: #e6a01e;
}
.unit {
  font-size: 11px;
  color: var(--text-dim);
}
.curve-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.curve {
  width: 100%;
  height: 70px;
  background: var(--bg);
  border-radius: 4px;
}
.curve-axis {
  stroke: var(--panel-border);
  stroke-width: 1;
}
.curve-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
}
.curve-cap {
  font-size: 10px;
  color: var(--text-dim);
}
.cal-empty {
  font-size: 12px;
  color: var(--text-dim);
}
</style>
