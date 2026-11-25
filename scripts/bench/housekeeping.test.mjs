// The bench's folders, records and slimming (paths.mjs, record.mjs, slim.mjs).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A fixed eval root, whatever this machine's paths.local.json says.
process.env.WEBSFM_EVAL = '/srv/eval'
const { EVAL, EXP, checkOut, expDir, slug } = await import('./paths.mjs')
const { backendOf, datasetFingerprint } = await import('./record.mjs')
const { slim, slimKeeps } = await import('./slim.mjs')

describe('paths', () => {
  it('takes the eval root from the environment', () => {
    expect(EVAL).toBe('/srv/eval')
  })

  it('makes a topic a folder name', () => {
    expect(slug('PUTI focal / RTK')).toBe('puti-focal-rtk')
    expect(() => slug('  // ')).toThrow()
  })

  it('reuses the newest folder of a topic, and starts a dated one otherwise', () => {
    const list = ['2026-11-20-focal', '2026-11-24-focal', '2026-11-24-focal-height', 'notes']
    expect(expDir('focal', { list })).toBe(join(EXP, '2026-11-24-focal'))
    expect(expDir('focal', { list, fresh: true })).toMatch(/\/exp\/\d{4}-\d{2}-\d{2}-focal$/)
    expect(expDir('lens', { list })).toMatch(/\/exp\/\d{4}-\d{2}-\d{2}-lens$/)
  })

  it('refuses an output loose at the top of the eval root', () => {
    expect(() => checkOut('/srv/eval/night-2026-11-06/nm-quarry')).toThrow(/loose/)
    expect(() => checkOut('/srv/eval')).toThrow()
    expect(() => checkOut('/srv/eval/results-old/x')).toThrow(/loose/) // a prefix is not the area
    expect(() => checkOut('/srv/eval/archive/t8-2026-11-09/x')).toThrow() // the archive is frozen
    expect(checkOut('/srv/eval/exp/2026-11-25-a/run')).toBe('/srv/eval/exp/2026-11-25-a/run')
    expect(checkOut('/srv/eval/results/1.0/job')).toBe('/srv/eval/results/1.0/job')
    expect(checkOut('/scratch/elsewhere')).toBe('/scratch/elsewhere')
  })
})

describe('record', () => {
  it('reads the backend a run used from its log', () => {
    const gpu = '12:00 info Matching: backend = WebGPU (nvidia turing) — brute-force …\n'
    expect(backendOf(gpu)).toBe('nvidia turing')
    // One SwiftShader stage spoils the run's timings, even after a GPU one.
    expect(backendOf(gpu + 'x backend = WebGPU (google swiftshader) — …')).toBe('SwiftShader')
    expect(backendOf('no GPU line at all')).toBeNull()
  })

  it('fingerprints a photo set by names and sizes, with include and limit', () => {
    const d = mkdtempSync(join(tmpdir(), 'fp-'))
    writeFileSync(join(d, 'a.jpg'), 'aa')
    writeFileSync(join(d, 'b.jpg'), 'bbb')
    writeFileSync(join(d, 'c.png'), 'c')
    const all = datasetFingerprint(d)
    expect(all).toMatchObject({ files: 3, bytes: 6 })
    expect(datasetFingerprint(d, { include: '\\.jpg$' })).toMatchObject({ files: 2, bytes: 5 })
    expect(datasetFingerprint(d, { limit: 1 })).toMatchObject({ files: 1, bytes: 2 })
    writeFileSync(join(d, 'b.jpg'), 'bbbb') // one size changes: another set
    expect(datasetFingerprint(d).sha256).not.toBe(all.sha256)
    expect(datasetFingerprint(join(d, 'missing'))).toBeNull()
  })
})

describe('slim', () => {
  it('keeps evidence and small files, not workspace', () => {
    expect(slimKeeps('run.json', 5e6)).toBe(true)
    expect(slimKeeps('console.log', 15 * 2 ** 20)).toBe(true)
    expect(slimKeeps('points.csv', 30 * 2 ** 20)).toBe(false) // a dump, not a record
    expect(slimKeeps('dem.tif', 1e8)).toBe(false)
    expect(slimKeeps('thumb.png', 10_000)).toBe(true)
  })

  it('removes workspace folders whole and counts what it frees', async () => {
    const d = mkdtempSync(join(tmpdir(), 'slim-'))
    mkdirSync(join(d, 'job/run.build/assets'), { recursive: true })
    mkdirSync(join(d, 'job/project.files'), { recursive: true })
    mkdirSync(join(d, 'job/tiles'), { recursive: true })
    writeFileSync(join(d, 'job/run.build/assets/a.json'), 'x'.repeat(10)) // evidence-like, but in a build
    writeFileSync(join(d, 'job/project.files/doc.xml'), 'y'.repeat(20))
    writeFileSync(join(d, 'job/tiles/t.tif'), Buffer.alloc(100_000))
    writeFileSync(join(d, 'job/run.json'), '{}')
    expect(await slim(d, false)).toBe(100_030)
    expect(existsSync(join(d, 'job/tiles/t.tif'))).toBe(true) // a count changes nothing
    expect(await slim(d, true)).toBe(100_030)
    expect(readdirSync(join(d, 'job'))).toEqual(['run.json'])
    expect(existsSync(join(d, 'SLIMMED.txt'))).toBe(true)
  })
})
