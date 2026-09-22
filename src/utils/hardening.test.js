import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushPersistence, trackPersistence, pendingPersistence, retryPersistence, persistenceFailures } from './persistence.js'
import { mergeProjectIndex } from './projectIndex.ts'
import { coalescedSave } from './coalescedSave.js'
import { buildPosesCsv, buildSensorsCsv } from './exportCsv.js'
import { isModelCached } from '../core/models/modelCache.js'

afterEach(() => vi.unstubAllGlobals())

it('checks model cache presence without consuming the response body', async () => {
  const arrayBuffer = vi.fn(() => { throw new Error('Must not read model weights') })
  vi.stubGlobal('caches', { open: async () => ({ match: async () => ({ arrayBuffer }) }) })
  expect(await isModelCached('/model')).toBe(true)
  expect(arrayBuffer).not.toHaveBeenCalled()
})

it.each(['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '\t=1', '\r=1', '  =1'])(
  'neutralizes spreadsheet expressions in text: %j', name => {
    expect(buildSensorsCsv([{ label: name }]).split('\r\n')[1]).toMatch(/^"?'/)
    expect(buildPosesCsv([{ imageName: name, x: -1.25 }], 'EPSG:3031')).toContain(',-1.25,')
  })

it('quotes carriage returns in CSV fields', () => {
  expect(buildSensorsCsv([{ label: 'a\rb' }])).toContain('"a\rb"')
})

it('merges independent field edits and never resurrects another session’s deleted project', () => {
  const baseline = [{ id: 'a', name: 'Old', crs: 'one' }, { id: 'b', name: 'Gone' }]
  const local = [{ id: 'a', name: 'New', crs: 'one' }, { id: 'b', name: 'New too' }]
  expect(mergeProjectIndex([{ id: 'a', name: 'Old', crs: 'two' }, { id: 'c' }], baseline, local))
    .toEqual([{ id: 'a', name: 'New', crs: 'two' }, { id: 'c' }])
})

it('tracks work before its first await and waits through trailing coalesced saves', async () => {
  let finish
  const first = new Promise(resolve => { finish = resolve })
  const written = []
  const save = coalescedSave('test-drain', async (id, value) => {
    if (!written.length) { written.push([id, value]); await first }
    else written.push([id, value])
  })
  const a = save('old-project', { n: 1 })
  expect(pendingPersistence.value).toBeGreaterThan(0)
  await Promise.resolve()
  const b = save('old-project', { n: 2 })
  expect(a).toBe(b)
  let flushed = false
  const flush = flushPersistence().then(() => { flushed = true })
  await Promise.resolve()
  expect(flushed).toBe(false)
  finish()
  await flush
  expect(written).toEqual([['old-project', { n: 1 }], ['old-project', { n: 2 }]])
})

it('retains failed saves until retry succeeds, blocking misleading successful exports', async () => {
  let fail = true
  await expect(trackPersistence('failure-probe', async () => { if (fail) throw new Error('disk full') })).rejects.toThrow('disk full')
  await expect(flushPersistence()).rejects.toThrow('Unsaved changes')
  expect(persistenceFailures.value.length).toBeGreaterThan(0)
  fail = false
  await retryPersistence()
  expect(persistenceFailures.value).toHaveLength(0)
})
