<script setup>
import { computed } from 'vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import { estimatedIntrinsics } from '../../../core/sfm/cameraEstimated.js'
import { resolveK } from '../../../core/sfm/reconstruction.js'
import { radialCurve, focalDelta } from '../../../core/eval/calibration.js'
import { EVAL_THRESHOLDS } from '../../../core/eval/health.js'

// Quality Report ▸ Calibration: per-sensor BA-refined focal vs nominal, the composed
// self-cal k-bag + its fit health, and a Δr(r) distortion curve. Thresholds come from
// the shared EVAL_THRESHOLDS table (WS2.6) — no more ad-hoc constants.
const recon = useReconstructionStore()
const imagesStore = useImagesStore()
const sensorsStore = useSensorsStore()

const FIT_RMS_WARN = EVAL_THRESHOLDS.selfCalFitRmsPx.warn
const FOCAL_WARN = EVAL_THRESHOLDS.focalDeltaPct.warn

const distBySensor = computed(() => {
  const m = new Map()
  for (const d of recon.summary?.selfCalDistortion ?? []) m.set(d.sensorId, d)
  return m
})
const selfCalWasOff = computed(() => (recon.summary?.selfCalDistortion?.length ?? 0) === 0)

const rows = computed(() => {
  const cameras = recon.sparseCameras
  return sensorsStore.sensors.map((sensor) => {
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
    const rMax = (refinedFx && w && h) ? Math.hypot(w / 2, h / 2) / refinedFx : 1
    const curve = dist ? radialCurve(dist, rMax, 40) : []
    return { id: sensor.id, label: sensor.label, nCams: cams.length, refinedFx, nominalFx, delta, dist, curve, rMax }
  }).filter((r) => r.nCams > 0 || r.dist)
})

const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d))

function polyline(curve) {
  if (!curve.length) return ''
  const W = 200, H = 70, pad = 4
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
  <div v-if="!rows.length" class="eval-loading">No reconstructed sensors.</div>
  <template v-else>
    <div v-if="selfCalWasOff" class="warn-box">
      Self-calibration was off for this run — no composed distortion to report.
      Focal comparison below still applies.
    </div>

    <div v-for="s in rows" :key="s.id" class="sensor-card">
      <div class="sensor-head">
        <span class="sensor-label">{{ s.label }}</span>
        <span class="sensor-cams">{{ s.nCams }} cam{{ s.nCams === 1 ? '' : 's' }}</span>
      </div>

      <div class="cal-grid">
        <div class="cal-item"><div class="cal-k">Refined fx</div><div class="cal-v">{{ fmt(s.refinedFx) }} <span class="unit">px</span></div></div>
        <div class="cal-item"><div class="cal-k">Nominal fx</div><div class="cal-v">{{ fmt(s.nominalFx) }} <span class="unit">px</span></div></div>
        <div class="cal-item">
          <div class="cal-k">Δ focal <span class="unit">(warn > ±{{ FOCAL_WARN }}%)</span></div>
          <div class="cal-v" :class="{ warn: s.delta.deltaPct != null && Math.abs(s.delta.deltaPct) > FOCAL_WARN }">
            {{ fmt(s.delta.deltaPx) }} px<span v-if="s.delta.deltaPct != null" class="unit">
              ({{ s.delta.deltaPct > 0 ? '+' : '' }}{{ s.delta.deltaPct.toFixed(1) }}%)</span>
          </div>
        </div>
      </div>

      <template v-if="s.dist">
        <div class="cal-grid">
          <div class="cal-item"><div class="cal-k">k1</div><div class="cal-v">{{ s.dist.k1?.toFixed(4) ?? '—' }}</div></div>
          <div class="cal-item"><div class="cal-k">k2</div><div class="cal-v">{{ s.dist.k2?.toFixed(4) ?? '—' }}</div></div>
          <div class="cal-item"><div class="cal-k">k3</div><div class="cal-v">{{ s.dist.k3?.toFixed(4) ?? '—' }}</div></div>
          <div class="cal-item">
            <div class="cal-k">Fit RMS <span class="unit">(warn > {{ FIT_RMS_WARN }})</span></div>
            <div class="cal-v" :class="{ warn: s.dist.fitRmsPx > FIT_RMS_WARN }">
              {{ s.dist.fitRmsPx?.toFixed(3) ?? '—' }} <span class="unit">px</span>
            </div>
          </div>
        </div>

        <div class="curve-wrap">
          <svg viewBox="0 0 200 70" class="curve" preserveAspectRatio="none">
            <line x1="4" y1="35" x2="196" y2="35" class="curve-axis" />
            <polyline :points="polyline(s.curve)" class="curve-line" />
          </svg>
          <div class="curve-cap">Δr(r) — {{ drAtEdge(s.curve)?.toFixed(3) ?? '—' }} at edge (r≈{{ s.rMax.toFixed(2) }})</div>
        </div>
      </template>
      <div v-else class="cal-empty">No composed distortion for this sensor.</div>
    </div>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading { padding: 24px; text-align: center; color: var(--text-dim); }
.sensor-card { border: 1px solid var(--panel-border); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.sensor-head { display: flex; justify-content: space-between; align-items: baseline; }
.sensor-label { font-size: 13px; font-weight: 600; color: var(--text); }
.sensor-cams { font-size: 11px; color: var(--text-dim); }
.cal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; }
.cal-item { display: flex; flex-direction: column; gap: 2px; }
.cal-k { font-size: 11px; color: var(--text-dim); }
.cal-v { font-size: 14px; color: var(--text); font-variant-numeric: tabular-nums; }
.cal-v.warn { color: #e6a01e; }
.unit { font-size: 11px; color: var(--text-dim); }
.curve-wrap { display: flex; flex-direction: column; gap: 4px; }
.curve { width: 100%; height: 70px; background: var(--bg); border-radius: 4px; }
.curve-axis { stroke: var(--panel-border); stroke-width: 1; }
.curve-line { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.curve-cap { font-size: 10px; color: var(--text-dim); }
.cal-empty { font-size: 12px; color: var(--text-dim); }
</style>
