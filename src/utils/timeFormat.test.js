import { describe, it, expect } from 'vitest'
import { formatClock, formatRemaining } from './timeFormat.js'

describe('formatClock (elapsed — exact)', () => {
  it('renders M:SS below an hour, zero-padded', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(9)).toBe('0:09')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(3599)).toBe('59:59')
  })

  it('switches to Xh Ym at an hour', () => {
    expect(formatClock(3600)).toBe('1h')
    expect(formatClock(3660)).toBe('1h 1m')
    expect(formatClock(9000)).toBe('2h 30m')
  })

  // Flooring the minutes is what stops 7170 s rendering as "1h 60m".
  it('never renders 60 minutes', () => {
    expect(formatClock(7170)).toBe('1h 59m')
    for (let s = 3600; s < 3600 * 5; s += 7) {
      expect(formatClock(s)).not.toMatch(/\b60m\b/)
    }
  })

  it('clamps negatives to zero', () => {
    expect(formatClock(-30)).toBe('0:00')
  })
})

describe('formatRemaining (ETA — coarse)', () => {
  it('does not count down the final seconds', () => {
    expect(formatRemaining(0)).toBe('less than a minute')
    expect(formatRemaining(59)).toBe('less than a minute')
  })

  it('rounds to the nearest minute under 10 minutes', () => {
    expect(formatRemaining(60)).toBe('1 minute')
    expect(formatRemaining(100)).toBe('2 minutes')
    expect(formatRemaining(270)).toBe('5 minutes')
  })

  it('rounds to 5 minutes under an hour', () => {
    expect(formatRemaining(660)).toBe('10 minutes')
    expect(formatRemaining(800)).toBe('15 minutes')
    expect(formatRemaining(1500)).toBe('25 minutes')
  })

  it('rounds to 10 minutes from an hour up', () => {
    expect(formatRemaining(3600)).toBe('1h')
    expect(formatRemaining(4200)).toBe('1h 10m')
    expect(formatRemaining(4500)).toBe('1h 20m') // 75 min → nearest 10
    expect(formatRemaining(8400)).toBe('2h 20m')
  })

  // The boundary that a naive round() gets wrong: 3599 s → 60 minutes, not an hour.
  it('never renders 60 minutes', () => {
    expect(formatRemaining(3599)).toBe('1h')
    for (let s = 0; s < 3600 * 6; s += 13) {
      expect(formatRemaining(s)).not.toMatch(/\b60m?\b(?! )/)
      expect(formatRemaining(s)).not.toBe('60 minutes')
    }
  })

  it('is singular only at one minute', () => {
    expect(formatRemaining(60)).toBe('1 minute')
    expect(formatRemaining(120)).toBe('2 minutes')
  })

  // Coarse buckets exist to stop the number twitching: a whole minute of ticks in the
  // middle of a long run must produce one stable string.
  it('is stable across a minute of ticking', () => {
    const seen = new Set()
    for (let s = 1500; s < 1560; s++) seen.add(formatRemaining(s))
    expect(seen.size).toBe(1)
  })

  it('clamps negatives', () => {
    expect(formatRemaining(-10)).toBe('less than a minute')
  })
})
