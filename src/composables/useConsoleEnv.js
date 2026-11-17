import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useMeasurementsStore } from '../stores/useMeasurementsStore.js'
import { useWorkflowsStore } from '../stores/useWorkflowsStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { useScaleBarsStore } from '../stores/useScaleBarsStore.js'
import { tuningOverrides, setTuningOverride } from '../stores/tuningOverrides.js'
import { useLog } from './useLog.js'
import { useI18n } from './useI18n.js'

const SOURCE = 'Console'

// The environment the console's executor (core/help/console.js) acts through: the
// command dispatch and guard state App already has, the workflow runner, and the
// stores the verbs read and change. Built once in App.vue, so the runner's pauses are
// reported even while the console panel is closed.
//
// Injected: dispatch (handleCommand), commandState (useRibbonState), workflowRunner
// (useWorkflowWiring), matchStats (useWorkspaceState).
export function useConsoleEnv({ dispatch, commandState, workflowRunner, matchStats }) {
  const { log, clear } = useLog()
  const i18n = useI18n()
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const matchesStore = useMatchesStore()
  const recon = useReconstructionStore()
  const gcps = useGcpsStore()
  const measurements = useMeasurementsStore()
  const workflows = useWorkflowsStore()
  const sensors = useSensorsStore()
  const footprints = useFootprintsStore()
  const scaleBars = useScaleBarsStore()

  // The lists an edit command names its objects from (core/help/consoleEdits.js).
  const named = (list, nameOf = (x) => x.name) => list.map((x) => ({ id: x.id, name: nameOf(x), ref: x }))
  const LISTS = {
    images: () => named(images.value),
    groups: () => named(imagesStore.imageGroups),
    sensors: () => named(sensors.sensors, (x) => x.label),
    products: () => [...named(recon.clouds), ...named(recon.rasterProducts)],
    layers: () => named(footprints.sets),
    gcps: () => named(gcps.gcps),
    scalebars: () => named(scaleBars.bars),
    workflows: () => named(workflows.workflows),
  }
  const isRaster = (p) => p.ref.kind === 'dem' || p.ref.kind === 'ortho'
  const ids = (items) => items.map((i) => i.id)
  const SENSOR_FIELDS = new Set([
    'label',
    'focalMm',
    'ppxMm',
    'ppyMm',
    'gnssLeverArmX',
    'gnssLeverArmY',
    'gnssLeverArmZ',
  ])

  // One edit per noun and action; the store call logs its Activity line. A return value
  // is the console's reply (for an edit the store does not confirm, or a refusal).
  const EDIT = {
    image: {
      rename: ([img, name]) => imagesStore.renameImage(img.id, name) || `"${img.name}" keeps its name`,
      enable: ([list]) => imagesStore.setImagesEnabled(ids(list), true) || 'Already enabled',
      disable: ([list]) => imagesStore.setImagesEnabled(ids(list), false) || 'Already disabled',
    },
    group: {
      create: ([name, list]) => void imagesStore.createImageGroup({ name, imageIds: ids(list) }),
      rename: ([g, name]) => void imagesStore.renameImageGroup(g.id, name),
      remove: ([g]) => void imagesStore.removeImageGroup(g.id),
      add: ([g, list]) => void imagesStore.setImagesGroup(ids(list), g.id),
      ungroup: ([list]) => void imagesStore.setImagesGroup(ids(list), null),
    },
    sensor: {
      set([sensor, fields]) {
        const bad = Object.keys(fields).filter((k) => k !== 'kind' && !SENSOR_FIELDS.has(k))
        if (bad.length) return { text: `Not a sensor field: ${bad.join(', ')}`, level: 'error' }
        for (const [k, v] of Object.entries(fields)) {
          if (k === 'kind') sensors.setSensorsKind([sensor.id], String(v))
          else sensors.updateSensor(sensor.id, k, v)
        }
      },
      film: ([sensor, mm]) => void sensors.applyFilmFormat(sensor.id, mm),
      assign: ([sensor, list]) => void sensors.assignImagesToSensor(ids(list), sensor.id),
      new: ([list]) => void sensors.newSensorForImages(ids(list)),
    },
    product: {
      main: ([p]) => (recon.setMainProduct(p.id) === false ? `"${p.name}" is already the main one` : undefined),
      rename: ([p, name]) => void (isRaster(p) ? recon.renameProduct(p.id, name) : recon.renameCloud(p.id, name)),
      remove: ([p]) => void (isRaster(p) ? recon.removeProduct(p.id) : recon.removeCloud(p.id)),
      show: ([p]) => (
        isRaster(p) ? recon.setProductVisible(p.id, true) : recon.setCloudVisible(p.id, true),
        `Showing "${p.name}"`
      ),
      hide: ([p]) => (
        isRaster(p) ? recon.setProductVisible(p.id, false) : recon.setCloudVisible(p.id, false),
        `Hiding "${p.name}"`
      ),
      style([p, fields]) {
        if (!isRaster(p)) return { text: 'Only a DEM or an orthophoto has a style here', level: 'error' }
        recon.setProductStyle(p.id, { ...(p.ref.style ?? {}), ...fields })
      },
    },
    layer: {
      rename: ([l, name]) => void footprints.renameSet(l.id, name),
      remove: ([l]) => void footprints.removeSet(l.id),
      show: ([l]) => void footprints.setSetVisible(l.id, true),
      hide: ([l]) => void footprints.setSetVisible(l.id, false),
    },
    gcp: {
      add: ([name, role]) => void gcps.addPoint({ name, role: role ?? 'control' }),
      set([g, fields]) {
        const bad = Object.keys(fields).filter((k) => !['x', 'y', 'z'].includes(k))
        if (bad.length) return { text: `A GCP takes x=, y=, z=, not ${bad.join(', ')}`, level: 'error' }
        for (const [axis, v] of Object.entries(fields)) gcps.setGcpPosition(g.id, axis, v)
        const r = g.ref
        return `GCP ${g.name}: x ${r.x ?? '—'}, y ${r.y ?? '—'}, z ${r.z ?? '—'}`
      },
      role: ([g, role]) => void gcps.setGcpRole(g.id, role),
      enable: ([list]) => list.forEach((g) => gcps.setGcpEnabled(g.id, true)),
      disable: ([list]) => list.forEach((g) => gcps.setGcpEnabled(g.id, false)),
      remove: ([list]) => list.forEach((g) => gcps.removeGcp(g.id)),
    },
    scalebar: {
      add: ([a, b, length, unit]) =>
        void scaleBars.addBar({
          a: { kind: 'marker', id: a.id },
          b: { kind: 'marker', id: b.id },
          knownDistance: length,
          unit: unit ?? 'm',
        }),
      enable: ([list]) => list.forEach((b) => scaleBars.setBarEnabled(b.id, true)),
      disable: ([list]) => list.forEach((b) => scaleBars.setBarEnabled(b.id, false)),
      remove: ([list]) => list.forEach((b) => scaleBars.removeBar(b.id)),
    },
    matches: {
      remove: () => void matchesStore.clear({ purge: true }),
    },
    region: {
      set: ([[x0, y0, z0, x1, y1, z1]]) =>
        void recon.setRegion({
          min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
          max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
        }),
      clear: () => void recon.clearRegion(),
    },
    orientation: {
      clear: () => void recon.clearOrientation(),
    },
    template: {
      save: ([w]) => void workflows.saveTemplate(w.id),
    },
  }

  // A run the console started: report what the runner waits for, since the builder
  // dialog that shows it may not be open. 'blocked' is reported by the executor.
  let consoleRun = false
  const PROMPTS = {
    interactive: 'complete the opened dialog, then type "continue" (or "stop")',
    reuse: 'type "reuse" to keep it, "continue" to run it again, or "stop"',
    warning: 'type "continue" or "stop"',
  }
  watch(
    () => workflowRunner.pause.value,
    (pause) => {
      if (consoleRun && pause && PROMPTS[pause.kind])
        log(`Workflow waiting: ${pause.message} — ${PROMPTS[pause.kind]}`, 'warn', SOURCE)
    },
  )

  function frameLabel() {
    const sig = recon.currentFrameSignature
    if (sig.source === 'georef') return `georeferenced in ${sig.crs} (metres)`
    if (sig.source === 'scalebars') return 'scaled by scale bars (metres, no CRS)'
    return 'model units (no georeference or scale)'
  }

  return {
    log: (message, level = 'info') => log(message, level, SOURCE),
    clear,
    state: () => commandState.value,
    dispatch,
    workflows: () => workflows.workflows,
    async startWorkflow(workflow) {
      consoleRun = true
      try {
        return await workflowRunner.start(workflow)
      } finally {
        consoleRun = false
      }
    },
    workflowStatus: () => ({ running: workflowRunner.running.value, pause: workflowRunner.pause.value }),
    respond: (action) => workflowRunner.respond(action),
    stopWorkflow: () => workflowRunner.stop(),
    stats() {
      const sparse = recon.mainSparseCloud
      const ms = matchStats.value
      return {
        images: images.value.length,
        detected: images.value.filter((i) => i.kpStatus === 'done').length,
        keypoints: images.value.reduce((n, i) => n + (i.kpCount || 0), 0),
        pairs: { total: ms.total, verified: ms.verified, excluded: ms.excluded, weak: ms.weak, failed: ms.error },
        sparse: sparse ? { cameras: sparse.cameras?.size ?? 0, points: sparse.points?.length ?? 0 } : null,
        depthMaps: recon.depthMapCount,
        dense: recon.clouds.filter((c) => c.kind === 'dense').map((c) => ({ name: c.name, points: c.count })),
        meshes: recon.clouds
          .filter((c) => c.kind === 'mesh')
          .map((c) => ({ name: c.name, triangles: c.count, textured: !!c.texture })),
        dem: recon.dem
          ? {
              width: recon.dem.width,
              height: recon.dem.height,
              gsd: recon.dem.gsd,
              unit: recon.dem.unit === 'model' ? 'model units' : (recon.dem.unit ?? ''),
            }
          : null,
        ortho: recon.ortho
          ? {
              width: recon.ortho.width,
              height: recon.ortho.height,
              gsd: recon.ortho.gsd,
              unit: recon.ortho.unit === 'model' ? 'model units' : (recon.ortho.unit ?? ''),
            }
          : null,
        gcps: gcps.gcps.length,
        measurements: measurements.records.length,
        frame: frameLabel(),
      }
    },
    images: () => images.value.map((i) => ({ id: i.id, uuid: i.uuid, name: i.name })),
    matchPairs() {
      const byUuid = new Map(images.value.map((i) => [i.uuid, i]))
      const out = []
      for (const [, e] of matchesStore.matchStore) {
        if (e.status !== 'done' || !(e.inlierCount > 0)) continue
        const a = byUuid.get(e.idA),
          b = byUuid.get(e.idB)
        if (!a || !b) continue
        out.push({
          nameA: a.name,
          nameB: b.name,
          idA: a.id,
          idB: b.id,
          inliers: e.inlierCount,
          enabled: e.enabled !== false,
          weak: !!e.weak,
        })
      }
      return out
    },
    pairState(uuidA, uuidB) {
      const pid = matchesStore.pairId(uuidA, uuidB)
      const e = matchesStore.matchStore.get(pid)
      return e && e.status === 'done' && e.inlierCount > 0
        ? { pid, enabled: e.enabled !== false, inliers: e.inlierCount }
        : null
    },
    setPairEnabled: (pid, on) => matchesStore.setPairEnabled(pid, on),
    selectImage: (id) => imagesStore.selectImage(id),
    items: (list) => LISTS[list]?.() ?? [],
    edit(noun, action, args) {
      const r = EDIT[noun][action](args)
      return typeof r === 'string' || (r && typeof r === 'object' && 'text' in r) ? r : undefined
    },
    language: () => i18n.locale.value,
    languages: () => i18n.languages,
    setLanguage: (id) => i18n.setLanguage(id),
    tuning: { get: tuningOverrides, set: setTuningOverride },
  }
}
