import { describe, it, expect } from 'vitest'
import {
  FORMAT_MIGRATIONS,
  applyMigrations,
  changedDocuments,
  documentMatches,
  migrationPlan,
  migrationsComplete,
  planDocuments,
  splitDocumentPath,
  transposedOpk,
} from './formatMigrations.js'
import { PROJECT_FORMAT_MIN, PROJECT_FORMAT_VERSION } from './projectFormat.js'
import { makeFrameModelResolver } from './sfm/displayFrame.js'
import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

const renameStep = {
  from: 1,
  note: 'GCP "xyz" became "coordinates"',
  documents: ['gcps.json'],
  migrate(docs) {
    const g = docs['gcps.json']
    if (g) docs['gcps.json'] = { ...g, gcps: g.gcps.map(({ xyz, ...p }) => ({ ...p, coordinates: xyz })) }
    return docs
  },
}
const productStep = {
  from: 2,
  note: 'products carry a kind',
  documents: ['products/*.json'],
  migrate(docs) {
    for (const [path, doc] of Object.entries(docs)) {
      if (path.startsWith('products/') && doc) docs[path] = { ...doc, kind: doc.kind ?? 'dem' }
    }
    return docs
  },
}

describe('the migration table', () => {
  it('covers every version a project can still be opened from', () => {
    // Raising PROJECT_FORMAT_VERSION without a step from the version before fails here.
    expect(migrationsComplete(FORMAT_MIGRATIONS)).toBe(true)
    expect(migrationPlan(PROJECT_FORMAT_MIN, PROJECT_FORMAT_VERSION)).toHaveLength(
      PROJECT_FORMAT_VERSION - PROJECT_FORMAT_MIN,
    )
  })

  it('gives each step a note, its documents and a version it reads', () => {
    for (const step of FORMAT_MIGRATIONS) {
      expect(step.note).toBeTruthy()
      expect(Array.isArray(step.documents)).toBe(true)
      for (const d of step.documents) expect(() => splitDocumentPath(d)).not.toThrow()
      expect(Number.isInteger(step.from)).toBe(true)
    }
  })
})

describe('migrationPlan', () => {
  it('is empty for a project in this version', () => {
    expect(migrationPlan(3, 3, [])).toEqual([])
  })

  it('orders the steps by the version they read', () => {
    expect(migrationPlan(1, 3, [productStep, renameStep])).toEqual([renameStep, productStep])
  })

  it('refuses a gap rather than open a project half-read', () => {
    expect(() => migrationPlan(1, 3, [renameStep])).toThrow(/from version 2 to 3/)
    expect(migrationsComplete([productStep])).toBe(PROJECT_FORMAT_VERSION === PROJECT_FORMAT_MIN)
  })
})

describe('document paths', () => {
  it('lists project.json first and each document once', () => {
    expect(planDocuments([renameStep, productStep, { ...renameStep, from: 3 }])).toEqual([
      'project.json',
      'gcps.json',
      'products/*.json',
    ])
  })

  it('matches dir/*.json against the documents of that folder only', () => {
    expect(documentMatches('products/*.json', 'products/dem.json')).toBe(true)
    expect(documentMatches('products/*.json', 'products/a/dem.json')).toBe(false)
    expect(documentMatches('products/*.json', 'dem.json')).toBe(false)
    expect(documentMatches('products/*.json', 'products/dem.bin')).toBe(false)
    expect(documentMatches('*.json', 'gcps.json')).toBe(true)
    expect(documentMatches('*.json', 'products/dem.json')).toBe(false)
    expect(documentMatches('gcps.json', 'gcps.json')).toBe(true)
  })

  it('refuses unsafe paths and other patterns', () => {
    expect(() => splitDocumentPath('../x.json')).toThrow(/unsafe/)
    expect(() => splitDocumentPath('a//x.json')).toThrow(/unsafe/)
    expect(() => splitDocumentPath('products/dem-*.json')).toThrow(/only dir/)
  })
})

describe('applyMigrations', () => {
  const docs = {
    'project.json': { name: 'P', formatVersion: 1 },
    'gcps.json': { gcps: [{ id: 'a', xyz: [1, 2, 3] }] },
    'products/dem.json': { width: 4 },
    'poses.json': { poses: [] },
  }

  it('runs each step, stamps the version and leaves the input alone', () => {
    const before = structuredClone(docs)
    const { docs: out, notes } = applyMigrations(docs, [renameStep, productStep])
    expect(docs).toEqual(before)
    expect(out['project.json'].formatVersion).toBe(3)
    expect(out['gcps.json'].gcps[0]).toEqual({ id: 'a', coordinates: [1, 2, 3] })
    expect(out['products/dem.json'].kind).toBe('dem')
    expect(out['poses.json']).toEqual(docs['poses.json'])
    expect(notes).toEqual(['format 1 → 2: GCP "xyz" became "coordinates"', 'format 2 → 3: products carry a kind'])
  })

  it('shows a step only the documents it named', () => {
    let seen = null
    const peek = { from: 1, note: 'n', documents: ['products/*.json'], migrate: (d) => ((seen = Object.keys(d)), d) }
    applyMigrations(docs, [peek])
    expect(seen.sort()).toEqual(['products/dem.json', 'project.json'])
  })

  it('treats a project without a version as version 1', () => {
    const { docs: out } = applyMigrations({ 'project.json': { name: 'old' } }, [renameStep])
    expect(out['project.json']).toEqual({ name: 'old', formatVersion: 2 })
  })

  it('refuses a project of another version, and a step that drops project.json', () => {
    expect(() => applyMigrations(docs, [productStep])).toThrow(/got a version 1 project/)
    const drop = { from: 1, note: 'n', documents: [], migrate: (d) => ({ ...d, 'project.json': null }) }
    expect(() => applyMigrations(docs, [drop])).toThrow(/removed project.json/)
  })
})

describe('changedDocuments', () => {
  it('names the created, rewritten and deleted documents', () => {
    const before = { a: { x: 1 }, b: { y: 2 }, c: null, d: { z: 1 } }
    const after = { a: { x: 1 }, b: { y: 3 }, c: { new: true }, d: null }
    expect(changedDocuments(before, after).sort()).toEqual(['b', 'c', 'd'])
  })
})

describe('format 1 → 2: omega/phi/kappa in the Metashape and Pix4D sense', () => {
  const step = FORMAT_MIGRATIONS.find((s) => s.from === 1)

  it('transposes the rotation of gimbal-derived angles, and of nothing else', async () => {
    const { droneYprToOpk } = await import('./io/metadata.js')
    const { opkMatrix } = await import('./footprint.js')
    // Version 1 wrote the angles of the transposed rotation for a DJI gimbal reading.
    const now = droneYprToOpk(32.5, -75, 3)
    const old = transposedOpk(now.omega, now.phi, now.kappa)
    const fromFile = { omega: 4, phi: -3, kappa: 120 }
    const docs = {
      'project.json': {
        formatVersion: 1,
        images: [
          {
            id: 'a',
            meta: {
              cameraOmega: old[0],
              cameraPhi: old[1],
              cameraKappa: old[2],
              cameraOrientationSource: 'xmp-gimbal',
            },
          },
          { id: 'b', meta: { cameraOmega: 1, cameraPhi: 2, cameraKappa: 3, cameraOrientationSource: 'exif-opk' } },
          { id: 'c', meta: null },
        ],
      },
      'poses.json': {
        crs: 'EPSG:32632',
        poses: [
          {
            source: 'exif',
            orientationSource: 'xmp-gimbal',
            omega: old[0],
            phi: old[1],
            kappa: old[2],
            omegaEnu: old[0],
            phiEnu: old[1],
            kappaEnu: old[2],
          },
          { source: 'imported', ...fromFile },
          { source: 'exif', orientationSource: 'xmp-gimbal', omega: null, phi: null, kappa: null },
        ],
      },
    }
    const { docs: out } = applyMigrations(docs, [step])
    const [a, b, c] = out['project.json'].images
    const same = (angles, ref) => {
      const A = opkMatrix(...angles),
        B = opkMatrix(ref.omega, ref.phi, ref.kappa)
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(A[i][j]).toBeCloseTo(B[i][j], 12)
    }
    same([a.meta.cameraOmega, a.meta.cameraPhi, a.meta.cameraKappa], now)
    expect(b).toEqual(docs['project.json'].images[1])
    expect(c).toEqual(docs['project.json'].images[2])
    const [p0, p1, p2] = out['poses.json'].poses
    same([p0.omega, p0.phi, p0.kappa], now)
    same([p0.omegaEnu, p0.phiEnu, p0.kappaEnu], now)
    expect(p1).toEqual(docs['poses.json'].poses[1])
    expect(p2).toMatchObject({ omega: null, phi: null, kappa: null })
    expect(out['project.json'].formatVersion).toBe(2)
  })

  it('leaves a project without poses alone', () => {
    const { docs: out } = applyMigrations({ 'project.json': { formatVersion: 1, images: [] }, 'poses.json': null }, [
      step,
    ])
    expect(out['poses.json']).toBeNull()
  })
})

describe('version 2 → 3: documents into folders', () => {
  const step = FORMAT_MIGRATIONS.find((s) => s.from === 2)

  it('moves every document out of the folder top, and leaves project.json', () => {
    const docs = {
      'project.json': { name: 'p', formatVersion: 2 },
      'sensors.json': { sensors: [1] },
      'gcps.json': { gcps: [] },
      'poses.json': null,
      'reconstruction.json': {
        version: 3,
        clouds: [],
        binaryFiles: { 'c.pos': { name: 'reconstruction.json.g.c.pos.bin', bytes: 24 } },
      },
      'dialogs.json': { dense: {} },
    }
    for (const p of step.documents) if (!(p in docs)) docs[p] = null
    const out = step.migrate(structuredClone(docs))
    expect(out['project.json']).toEqual(docs['project.json'])
    expect(out['sensors.json']).toBeNull()
    expect(out['data/sensors.json']).toEqual({ sensors: [1] })
    expect(out['data/gcps.json']).toEqual({ gcps: [] })
    // A document the project never had is not made up.
    expect(out['data/poses.json']).toBeNull()
    // The reconstruction keeps the names of its binary files, which have not moved.
    expect(out['reconstruction/reconstruction.json']).toEqual(docs['reconstruction.json'])
    expect(out['reconstruction.json']).toBeNull()
    expect(out['internal/dialogs.json']).toEqual({ dense: {} })
  })

  it('runs after version 1 → 2 on the documents that step changed', () => {
    const plan = migrationPlan(1, 3)
    const docs = Object.fromEntries(planDocuments(plan).map((p) => [p, null]))
    docs['project.json'] = { formatVersion: 1, images: [] }
    docs['poses.json'] = { poses: [{ source: 'exif', orientationSource: 'xmp-gimbal', omega: 10, phi: 0, kappa: 0 }] }
    const { docs: out } = applyMigrations(docs, plan)
    expect(out['poses.json']).toBeNull()
    expect(out['data/poses.json'].poses[0].omega).toBeCloseTo(-10)
  })
})

describe('version 3 → 4: each sparse model keeps its own lens', () => {
  const step = FORMAT_MIGRATIONS.find((s) => s.from === 3)
  // The saved v3 fixture project (tests/fixtures/projects/v3): its own documents.
  const fixtureDocs = () => {
    const files = unzipSync(
      readFileSync(new URL('../../tests/fixtures/projects/v3/aukerman-5.websfm', import.meta.url)),
    )
    const json = (p) => (files[p] ? JSON.parse(strFromU8(files[p])) : null)
    return Object.fromEntries(step.documents.map((p) => [p, json(p)]))
  }

  it('gives every sparse cloud the frame model the run summary gave it, exactly', () => {
    const docs = fixtureDocs()
    const recon = docs['reconstruction/reconstruction.json']
    expect(recon.summary.selfCalDistortion.length).toBeGreaterThan(0) // the fixture self-calibrated
    const sensors = docs['data/sensors.json'].sensors
    const images = docs['project.json'].images
    const before = makeFrameModelResolver({ summary: recon.summary, sensors })
    const out = step.migrate(structuredClone(docs))
    const sparse = out['reconstruction/reconstruction.json'].clouds.filter((c) => c.kind === 'sparse')
    expect(sparse.length).toBeGreaterThan(0)
    for (const cloud of sparse) {
      expect(cloud.calibration.source).toBe('migrated')
      const after = makeFrameModelResolver({ calibration: cloud.calibration, sensors })
      for (const cam of cloud.cameras) {
        const im = images.find((i) => i.uuid === cam.uuid)
        // dist, selfCal and the film frame: what depth-map reuse keys on.
        expect(after(im)).toEqual(before(im))
      }
    }
    // Dense clouds and meshes are not touched.
    for (const c of out['reconstruction/reconstruction.json'].clouds.filter((c) => c.kind !== 'sparse'))
      expect(c.calibration).toBeUndefined()
  })

  it('marks a model that is not the main one: its lens was not recorded for it', () => {
    const docs = fixtureDocs()
    const recon = docs['reconstruction/reconstruction.json']
    const main = recon.clouds.find((c) => c.kind === 'sparse')
    recon.clouds.push({ ...structuredClone(main), id: 'other', imported: true })
    const out = step.migrate(structuredClone(docs))
    const byId = new Map(out['reconstruction/reconstruction.json'].clouds.map((c) => [c.id, c]))
    expect(byId.get(main.id).calibration.source).toBe('migrated')
    expect(byId.get('other').calibration.source).toBe('not-recorded')
  })

  it('leaves a project without a reconstruction, and a cloud that has a calibration, as they are', () => {
    const empty = {
      'project.json': { images: [] },
      'data/sensors.json': null,
      'reconstruction/reconstruction.json': null,
    }
    expect(step.migrate(structuredClone(empty))).toEqual(empty)
    const docs = fixtureDocs()
    const own = { groups: [], fiducialTransforms: [], source: 'colmap' }
    docs['reconstruction/reconstruction.json'].clouds.find((c) => c.kind === 'sparse').calibration = own
    const out = step.migrate(structuredClone(docs))
    expect(out['reconstruction/reconstruction.json'].clouds.find((c) => c.kind === 'sparse').calibration).toEqual(own)
  })
})
