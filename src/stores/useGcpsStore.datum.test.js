import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it } from 'vitest'
import { useGcpsStore } from './useGcpsStore.js'
import { useProjectsStore } from './useProjectsStore.js'

// Heights from a reference DEM, and the explicit conversion, in the GCP's own
// vertical datum (core/verticalDatum.js; the sampler and the shift are injected).
beforeEach(() => {
  setActivePinia(createPinia())
  const projects = useProjectsStore()
  projects.persistenceAvailable = false
  projects.projects = [{ id: 'p', name: 'p', crs: 'EPSG:3031' }]
  projects.currentProjectId = 'p'
})

function twoGcps() {
  const store = useGcpsStore()
  const a = store.addGcp(),
    b = store.addGcp()
  store.setGcpVerticalDatum(a, 'ellipsoidal')
  return { store, a, b, gcp: (id) => store.gcps.find((g) => g.id === id) }
}

it("fills Z in the GCP's declared datum when the DEM converts to it, else takes the DEM's", async () => {
  const { store, a, b, gcp } = twoGcps()
  const asked = []
  // An EGM2008 DEM at 100 m; where the geoid lies 52 m below the ellipsoid.
  const sampleDem = async (x, y, { datum } = {}) => {
    asked.push(datum)
    return datum === 'ellipsoidal'
      ? { z: 48, accuracy: 2, datum: 'ellipsoidal', shift: -52, sourceDatum: 'geoid:EGM2008', rasterName: 'cop30' }
      : { z: 100, accuracy: 2, datum: 'geoid:EGM2008', rasterName: 'cop30' }
  }
  await store.fillZFromReferenceDem(sampleDem)
  expect(asked).toEqual(['ellipsoidal', 'unknown'])
  expect(gcp(a)).toMatchObject({ z: 48, accuracyZ: 2, verticalDatum: 'ellipsoidal' })
  expect(gcp(b)).toMatchObject({ z: 100, accuracyZ: 2, verticalDatum: 'geoid:EGM2008' })
})

it('converts heights only between datums it can convert, and leaves the rest', async () => {
  const { store, a, b, gcp } = twoGcps()
  store.setGcpPosition(a, 'z', 10)
  store.setGcpPosition(b, 'z', 20)
  store.setGcpVerticalDatum(b, 'orthometric')
  const shiftAt = async (g, from) => (from === 'ellipsoidal' ? 53.4 : null)
  expect(await store.convertGcpHeights('geoid:EGM96', shiftAt)).toEqual({ converted: 1, skipped: 1 })
  expect(gcp(a)).toMatchObject({ verticalDatum: 'geoid:EGM96' })
  expect(gcp(a).z).toBeCloseTo(63.4, 9)
  expect(gcp(b)).toMatchObject({ z: 20, verticalDatum: 'orthometric' })
  // A datum outside the vocabulary is refused outright.
  expect(await store.convertGcpHeights('NAVD88', shiftAt)).toEqual({ converted: 0, skipped: 0 })
})
