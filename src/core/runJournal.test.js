import { describe, it, expect } from 'vitest'
import { canContinue, journalKey, journalSummary, journalWriter, stableStringify, startJournal } from './runJournal.js'

describe('journalKey', () => {
  it('ignores key order and undefined fields, and sees any changed value', () => {
    const a = { sparse: ['c1', 5], images: ['u1', 'u2'], settings: { quality: 'medium', maxDim: 0 } }
    const b = { settings: { maxDim: 0, quality: 'medium', gone: undefined }, images: ['u1', 'u2'], sparse: ['c1', 5] }
    expect(journalKey(a)).toBe(journalKey(b))
    expect(journalKey(a)).toMatch(/^[0-9a-f]{16}$/)
    expect(journalKey({ ...a, images: ['u2', 'u1'] })).not.toBe(journalKey(a))
    expect(journalKey({ ...a, settings: { quality: 'high', maxDim: 0 } })).not.toBe(journalKey(a))
  })

  it('writes plain data stably', () => {
    expect(stableStringify({ b: [1, { d: null, c: 'x' }], a: true })).toBe('{"a":true,"b":[1,{"c":"x","d":null}]}')
  })
})

describe('a journal', () => {
  const now = new Date('2026-10-30T10:00:00Z')

  it('starts empty, with its own copy of the settings', () => {
    const settings = { quality: 'high' }
    const j = startJournal({ stage: 'depth', key: 'k', settings, total: 347, phase: 'pass1', now })
    settings.quality = 'low'
    expect(j).toMatchObject({ stage: 'depth', key: 'k', total: 347, phase: 'pass1', done: [] })
    expect(j.settings.quality).toBe('high')
    expect(j.startedAt).toBe('2026-10-30T10:00:00.000Z')
  })

  it('continues only on the same inputs', () => {
    expect(canContinue({ key: 'k' }, 'k')).toEqual({ ok: true })
    expect(canContinue({ key: 'k' }, 'other').ok).toBe(false)
    expect(canContinue(null, 'k').ok).toBe(false)
  })

  it('says how far it got and when', () => {
    const j = { total: 347, done: new Array(212), updatedAt: '2026-10-30T07:50:00Z' }
    expect(journalSummary(j, 'Depth maps', now)).toBe('Depth maps stopped at 212 of 347, 2 h 10 min ago.')
    expect(journalSummary({ ...j, updatedAt: '2026-10-30T09:59:40Z' }, 'Matching', now)).toBe(
      'Matching stopped at 212 of 347, less than a minute ago.',
    )
  })
})

describe('journalWriter', () => {
  it('saves at most once per interval, at once when flushed, never overlapping', async () => {
    let t = 0
    const writes = []
    let open = 0,
      maxOpen = 0
    const writer = journalWriter(
      async (j) => {
        open++
        maxOpen = Math.max(maxOpen, open)
        await new Promise((r) => setTimeout(r, 1))
        writes.push(j.done.length)
        open--
      },
      { intervalMs: 1000, now: () => t },
    )
    const j = { done: [] }
    t = 5000
    j.done.push(1)
    writer.touch(j) // first: saved
    j.done.push(2)
    writer.touch(j) // within the interval: remembered
    t = 5500
    j.done.push(3)
    writer.touch(j)
    t = 6100
    j.done.push(4)
    writer.touch(j) // the interval passed: saved
    j.done.push(5)
    writer.touch(j) // within the interval again: remembered
    await writer.flush() // the remembered one
    await writer.settled()
    expect(writes).toEqual([1, 4, 5])
    expect(maxOpen).toBe(1)
  })

  it('saves a snapshot, so later units do not change what was written', async () => {
    let saved = null
    const writer = journalWriter(async (j) => (saved = j), { now: () => 0 })
    const j = { done: [1] }
    await writer.flush(j)
    j.done.push(2)
    expect(saved.done).toEqual([1])
  })
})
