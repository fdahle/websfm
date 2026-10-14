import { it, expect } from 'vitest'
import { createLatest } from './latestOnly.js'

it('only the most recent token is current', () => {
  const latest = createLatest()
  const a = latest.begin()
  expect(latest.isCurrent(a)).toBe(true)
  const b = latest.begin()
  expect(latest.isCurrent(a)).toBe(false)
  expect(latest.isCurrent(b)).toBe(true)
})

// The case it exists for: an older refresh resolving after a newer one.
it('lets a newer refresh win when an older one finishes last', async () => {
  const latest = createLatest()
  let shown = null
  const refresh = async (value, ms) => {
    const token = latest.begin()
    await new Promise((r) => setTimeout(r, ms))
    if (latest.isCurrent(token)) shown = value
  }
  await Promise.all([refresh('old', 20), refresh('new', 1)])
  expect(shown).toBe('new')
})

it('keeps separate sequences independent', () => {
  const a = createLatest(), b = createLatest()
  const ta = a.begin()
  b.begin(); b.begin()
  expect(a.isCurrent(ta)).toBe(true)
})
