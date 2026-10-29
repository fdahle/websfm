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
} from './formatMigrations.js'
import { PROJECT_FORMAT_MIN, PROJECT_FORMAT_VERSION } from './projectFormat.js'

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
