import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import {
  chainCoregistration,
  coregisterDem,
  coregisterDemGrid,
  coregistrationAnchors,
  coregistrationMove,
  coregistrationPairs,
  sampleDemPoints,
} from '../core/products/demCoregistration.js'
import { describeCoregistration } from '../core/stepEffects/coregister.js'
import { demLayerTest } from './demLayerTest.js'
import { useLog } from './useLog.js'

// Tools ▸ Products ▸ Co-register DEM…: a DEM against a reference DEM, on stable ground,
// the steps xDEM chains (core/products/demCoregistration.js), applied to a copy of the
// DEM or to the georeference. On the main thread, as Quality Report ▸ DEM vs reference:
// about 20,000 cells and a dozen reference samples each take well under a second, and
// the reference sampler (reprojection, datum) lives here.
export function useDemCoregistration() {
  const recon = useReconstructionStore()
  const external = useExternalStore()
  const footprints = useFootprintsStore()
  const projects = useProjectsStore()
  const { log } = useLog()

  // Whether a co-registration of this DEM moves the georeference on from where the
  // current one put it: the DEM was built in the co-registered georeference.
  function chainsOnto(dem) {
    return !!recon.coregistration && !!recon.georef?.coregistered && !recon.productStatus(dem).outdated
  }

  // settings: { demId, referenceId, stableSetId, horizontal, vertical, tilt, applyTo }
  // → { result (coregisterDem), record (the new DEM, applyTo 'dem'), unit (the
  // DEM's height unit label, '' in model units) }. Throws with a user-facing reason.
  async function run(settings) {
    const dem = recon.productById(settings.demId) ?? recon.dem
    const meta = external.rasterById(settings.referenceId)
    if (!dem || !meta) throw new Error('Co-register DEM: needs a DEM and a reference DEM')
    const stable = settings.stableSetId ? footprints.sets.find((s) => s.id === settings.stableSetId) : null
    const label = `Co-register "${dem.name}" to "${meta.name}"`
    // Strict: a reference hole is missing coverage, not a neighbour's height. In the
    // DEM's vertical datum when the reference's converts to it.
    const { sample } = await external.referenceDemSampler(meta.id, dem.crs, {
      strict: true,
      datum: dem.verticalDatum ?? null,
    })
    const include = await demLayerTest(dem, [stable], projects.currentCrs)
    const { points, cell } = sampleDemPoints(dem, { include })
    const result = coregisterDem(points, sample, {
      cell,
      horizontal: settings.horizontal,
      vertical: settings.vertical,
      tilt: settings.tilt,
    })
    if (result.error === 'overlap')
      throw new Error(`${label}: too few cells${stable ? ` inside "${stable.name}"` : ''} overlap the reference`)
    if (result.error === 'slopes')
      throw new Error(`${label}: too few slopes of every aspect for the horizontal shift; turn it off`)
    const u = dem.unit && dem.unit !== 'model' ? ` ${dem.unit}` : ''
    const f = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`
    log(
      `${label}: on ${result.before.n.toLocaleString()} cells${stable ? ` of "${stable.name}"` : ''}, ` +
        (settings.horizontal ? `shift E ${f(result.shift[0])}, N ${f(result.shift[1])}${u}` : 'no horizontal shift') +
        (result.horizontal ? ` (${result.horizontal.iterations} iterations)` : '') +
        `, vertical ${f(result.vertical)}${u}` +
        (result.tilt ? `, ${result.tilt.order === 1 ? 'plane' : 'quadratic surface'} removed` : '') +
        `; NMAD ${result.before.nmad.toFixed(2)} → ${result.after.nmad.toFixed(2)}${u}, ` +
        `median ${f(result.before.median)} → ${f(result.after.median)}${u}`,
      'success',
      'Products',
    )
    const steps = { horizontal: settings.horizontal, vertical: settings.vertical, tilt: settings.tilt }
    const summary = {
      reference: meta.name,
      referenceId: meta.id,
      stable: stable?.name ?? null,
      steps,
      shift: result.shift,
      vertical: result.vertical,
      tilt: result.tilt,
      before: result.before,
      after: result.after,
      createdAt: Date.now(),
    }

    if (settings.applyTo === 'georeference') {
      const pairs = chainsOnto(dem)
        ? chainCoregistration(recon.coregistration.pairs, result)
        : coregistrationPairs(coregistrationAnchors(points), result)
      const record = {
        ...summary,
        crs: dem.crs,
        pairs,
        move: coregistrationMove(pairs),
        tilt: !!result.tilt || !!(chainsOnto(dem) && recon.coregistration.tilt),
      }
      const g = recon.setCoregistration(record)
      log(
        g?.coregistered
          ? `Georeference: co-registered to ${describeCoregistration(record)}; rebuild the DEM and orthophoto`
          : 'Georeference: the co-registration is kept, and applies to the next fit',
        'info',
        'Products',
      )
      return { result, unit: u.trim() }
    }
    const grid = coregisterDemGrid(dem, result)
    const record = await recon.addCoregisteredDem(dem, grid, summary)
    log(`${label}: added "${record.name}"`, 'info', 'Products')
    return { result, record, unit: u.trim() }
  }

  function removeFromGeoreference() {
    const had = recon.coregistration
    if (!had) return
    recon.setCoregistration(null)
    log(
      `Georeference: co-registration to "${had.reference}" removed; rebuild the DEM and orthophoto`,
      'info',
      'Products',
    )
  }

  return { run, chainsOnto, removeFromGeoreference }
}
