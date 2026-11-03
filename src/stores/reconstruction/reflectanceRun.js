// Products ▸ Reflectance map (plan-after-0.7 ▸ MSP-4; core/products/reflectanceMap.js,
// workers/ops/reflectance.js): one Float32 band per lens of a multispectral camera, on
// the DEM, in reflectance. The map goes into the project as a reference raster
// (Reference Data), where Style bands… shows any band, a false-colour composite or an
// index such as NDVI, and Export writes the GeoTIFF.
import * as opfs from '../../utils/opfs.js'
import { DEFAULT_BUDGET_BYTES } from '../../core/dense/memBudget.js'
import { isImageEnabled } from '../../core/imageEnabled.js'
import { findRigs, rigMembership } from '../../core/sensors/rig.js'
import { hasRadiometry, dlsIrradiance } from '../../core/radiometry/micasense.js'
import { resolveCalibration, calibrationFactor } from '../../core/products/reflectanceMap.js'
import { REFLECTANCE_DEFAULTS } from '../../core/defaults.user.js'
import { reflectanceStyle } from '../../core/products/reflectanceStyle.js'
import { pluralize } from '../../core/textFormat.js'
import {
  POOL_SIZE,
  reflectancePanels,
  reflectanceBegin,
  reflectanceAdd,
  reflectanceFinish,
  reflectanceShare,
} from '../../workers/computeClient.js'
import { useExternalStore } from '../useExternalStore.js'

const CALIBRATION_LABEL = {
  'panel+dls': 'calibration panel, carried to each photo by the sun sensor',
  'panel': 'calibration panel',
  'dls': 'sun sensor (DLS)',
  'radiance': 'none: radiance (W/m²/sr/nm)',
}

// A band record without what the worker does not need (structured clone of plain data).
const plainBand = (b) => JSON.parse(JSON.stringify(b))

export function createReflectanceRun({ dem, frameModelFor, images, log, mainSparseCloud, projects, reconStatus }) {
  const say = (m, level = 'info') => log(`Reflectance map: ${m}`, level, 'Products')

  // `settings`: REFLECTANCE_DEFAULTS' fields. `onProgress(done, total, label)`.
  // Returns the new reference raster's record, or null.
  async function generateReflectanceMap(settings = {}, onProgress) {
    const s = { ...REFLECTANCE_DEFAULTS, ...settings }
    const d = dem.value,
      sparse = mainSparseCloud.value
    if (!d?.data) {
      say('build a DEM first', 'warn')
      return null
    }
    if (!sparse?.cameras?.size) {
      say('build the sparse model first', 'warn')
      return null
    }
    // The rig, panel captures (disabled) included: they calibrate.
    const rigs = findRigs(images.value).sort((a, b) => b.captures.length - a.captures.length)
    if (!rigs.length) {
      say('no photo is a band of a multispectral camera', 'warn')
      return null
    }
    const rig = rigs[0]
    if (rigs.length > 1) say(`${pluralize(rigs.length - 1, 'other camera')} left out; this map is ${rig.label}`, 'warn')
    const member = rigMembership([rig])
    const bandIndex = new Map(rig.bands.map((b, i) => [b.key, i]))
    const panelCapture = new Set(rig.captures.filter((c) => c.panel).map((c) => c.id))
    const captureInt = new Map(rig.captures.map((c, i) => [c.id, i]))
    const projectId = projects.currentProjectId
    const urls = []
    const originalUrl = async (im) => {
      const file = im.file ?? (await opfs.loadImageBlob(projectId, im.uuid).catch(() => null))
      if (!file) return null
      const url = URL.createObjectURL(file)
      urls.push(url)
      return url
    }
    const onLog = (m, l, c) => log(m, l, c)
    reconStatus.value = 'running'
    try {
      const inRig = images.value.filter((im) => member.has(im.uuid))
      // ── Calibration ──────────────────────────────────────────────────────────
      const panelPhotos = inRig.filter((im) => im.meta.band.panel?.corners && hasRadiometry(im.meta.band))
      const haveDls = inRig.some((im) => dlsIrradiance(im.meta.band, im.meta.model) != null)
      const mode = resolveCalibration(s.calibration, { havePanel: panelPhotos.length > 0, haveDls })
      say(`calibration — ${CALIBRATION_LABEL[mode]}${s.calibration === 'auto' ? ' (auto)' : ''}`)
      let panels = {}
      if (mode.startsWith('panel')) {
        const payload = []
        for (const im of panelPhotos) {
          const url = await originalUrl(im)
          if (url)
            payload.push({
              key: member.get(im.uuid).band,
              name: im.name,
              url,
              band: plainBand(im.meta.band),
              model: im.meta.model,
              corners: im.meta.band.panel.corners,
            })
        }
        onProgress?.(0, 1, 'Reading the calibration panel…')
        panels = await reflectancePanels({ panels: payload }, { onLog, worker: 0 })
        for (const im of panelPhotos) {
          const p = panels[member.get(im.uuid).band]
          if (!p) continue
          p.albedo ??= im.meta.band.panel.albedo
          const e = dlsIrradiance(im.meta.band, im.meta.model)
          if (e != null) {
            p.eSum = (p.eSum ?? 0) + e
            p.eN = (p.eN ?? 0) + 1
          }
        }
        for (const [key, p] of Object.entries(panels)) {
          p.irradiance = p.eN ? p.eSum / p.eN : null
          const name = rig.bands.find((b) => b.key === key)?.name ?? key
          say(
            `${name} panel: radiance ${p.radiance.toPrecision(4)} W/m²/sr/nm over ${pluralize(p.photos, 'photo')}, ` +
              `albedo ${p.albedo}`,
          )
        }
      }
      // ── Photos ───────────────────────────────────────────────────────────────
      const frameModel = frameModelFor.value
      const photos = []
      const skipped = new Map() // band name → reason
      for (const im of inRig) {
        const m = member.get(im.uuid)
        if (panelCapture.has(m.capture) || !isImageEnabled(im)) continue
        const cam = sparse.cameras.get(im.uuid)
        if (!cam) continue
        const b = im.meta.band
        if (!b.thermal && !hasRadiometry(b)) {
          skipped.set(b.name, 'no radiometric calibration in its metadata')
          continue
        }
        // A band the panel did not cover falls back to the sun sensor, else to radiance.
        const bandMode = b.thermal
          ? 'radiance'
          : mode.startsWith('panel') && !panels[m.band]
            ? haveDls
              ? 'dls'
              : 'radiance'
            : mode
        const factor = b.thermal ? 1 : calibrationFactor(bandMode, panels[m.band], dlsIrradiance(b, im.meta.model))
        if (!Number.isFinite(factor)) {
          skipped.set(b.name, 'its photos have no sun-sensor reading')
          continue
        }
        const url = await originalUrl(im)
        if (!url) continue
        const { dist, selfCal } = frameModel(im)
        photos.push({
          uuid: im.uuid,
          name: im.name,
          url,
          capture: captureInt.get(m.capture),
          band: bandIndex.get(m.band),
          R: cam.R,
          t: cam.t,
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
          width: im.meta.width,
          height: im.meta.height,
          dist,
          selfCal,
          meta: { band: plainBand(b), model: im.meta.model },
          factor,
        })
      }
      for (const [name, why] of skipped) say(`${name} left out — ${why}`, 'warn')
      // Only the bands that have photos, in the rig's order.
      const used = rig.bands.filter((b, i) => photos.some((p) => p.band === i))
      if (!used.length) {
        say('no aligned band photo to map', 'warn')
        return null
      }
      const remap = new Map(used.map((b) => [bandIndex.get(b.key), used.indexOf(b)]))
      for (const p of photos) p.band = remap.get(p.band)
      const refBand = Math.max(
        0,
        used.findIndex((b) => b.reference),
      )
      const bands = used.map((b) => ({
        key: b.key,
        name: b.thermal ? `${b.name} (°C)` : b.name,
        thermal: b.thermal,
        wavelength: b.wavelength,
      }))
      // ── Map, over the pool ───────────────────────────────────────────────────
      const writer = 0
      const shares = Math.max(1, POOL_SIZE - 1)
      const budget = s.memBudgetBytes > 0 ? s.memBudgetBytes : DEFAULT_BUDGET_BYTES
      const input = {
        dem: {
          width: d.width,
          height: d.height,
          gsd: d.gsd,
          originX: d.originX,
          originY: d.originY,
          data: d.data,
          mask: d.mask,
          frame: d.frame,
        },
        gsd: s.gsd,
        bands,
        refBand,
        photos,
        cacheBytes: Math.floor(budget / 2 / shares),
      }
      const plan = await reflectanceBegin(input, { onLog, worker: writer })
      say(
        `${plan.width.toLocaleString()} × ${plan.height.toLocaleString()} cells at ${plan.gsd.toPrecision(3)} ` +
          `${plan.unit ?? 'units'}, ${pluralize(bands.length, 'band')} (${bands.map((b) => b.name).join(', ')}), ` +
          `${pluralize(plan.captures, 'capture')}; ${pluralize(plan.blocks, 'block')} on ` +
          `${pluralize(Math.min(shares, plan.blocks), 'worker')}${POOL_SIZE > 1 ? ' (the GeoTIFF written on one more)' : ''}`,
      )
      // Contiguous runs of blocks, one per worker: a run's photos carry over from block to block.
      const nRuns = Math.min(shares, plan.blocks)
      const runs = Array.from({ length: nRuns }, (_, k) => {
        const from = Math.floor((k * plan.blocks) / nRuns),
          to = Math.floor(((k + 1) * plan.blocks) / nRuns)
        return Array.from({ length: to - from }, (_, i) => from + i)
      })
      const adds = []
      let blocksDone = 0,
        loads = 0
      await Promise.all(
        runs.map(async (run, k) => {
          const res = await reflectanceShare(input, run, {
            worker: POOL_SIZE > 1 ? k + 1 : writer,
            onLog,
            onBlock: (b) => {
              adds.push(reflectanceAdd(b, { worker: writer }))
              blocksDone++
              onProgress?.(blocksDone, plan.blocks, `Mapping… ${blocksDone} of ${pluralize(plan.blocks, 'block')}`)
            },
          })
          loads += res.loads
        }),
      )
      await Promise.all(adds)
      onProgress?.(plan.blocks, plan.blocks, 'Writing the GeoTIFF…')
      const { cog } = await reflectanceFinish({ worker: writer })
      say(
        `${pluralize(photos.length, 'band photo')} read ${loads} times; GeoTIFF ${(cog.size / 2 ** 20).toFixed(1)} MB`,
      )
      // ── Into the project ─────────────────────────────────────────────────────
      const external = useExternalStore()
      const name = `Reflectance ${rig.label}`
      const record = await external.importRaster(new File([cog], `${name}.tif`, { type: 'image/tiff' }), {
        origin: 'reflectance',
      })
      if (!record) return null
      // The band names label Style bands… and fill in an index's bands; the record keeps
      // how the map was made.
      const live = external.rasters.find((r) => r.id === record.id) ?? record
      live.bandNames = bands.map((b) => b.name)
      live.reflectance = { calibration: mode, bands: bands.map((b) => b.name), gsd: plan.gsd, unit: plan.unit }
      external.save()
      const style = reflectanceStyle(bands.map((b) => b.name))
      if (style) await external.setRasterStyle(record.id, style)
      reconStatus.value = 'done'
      return live
    } catch (err) {
      say(err?.message ?? String(err), 'error')
      reconStatus.value = 'error'
      return null
    } finally {
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }

  return { generateReflectanceMap }
}
