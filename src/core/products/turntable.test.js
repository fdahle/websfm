import { describe, it, expect } from 'vitest'
import { turntableStep, recorderFormat, recorderBitrate } from './turntable.js'
import { TURNTABLE_TUNING } from '../tuning.js'

describe('turntableStep', () => {
  it('turns one full circle in secondsPerTurn', () => {
    expect(turntableStep(0.05, 20).angle * 400).toBeCloseTo(2 * Math.PI)
  })

  it('caps a late frame so the view does not jump', () => {
    expect(turntableStep(5, 20).angle).toBeCloseTo(turntableStep(0.1, 20).angle)
    expect(turntableStep(-1, 20).angle).toBe(0)
  })

  it('ends a recording exactly one turn after it began', () => {
    let turned = 0
    let steps = 0
    for (;;) {
      const { angle, done } = turntableStep(0.033, 10, turned)
      turned += angle
      steps++
      if (done) break
    }
    expect(turned).toBeCloseTo(2 * Math.PI, 12)
    expect(steps).toBe(Math.ceil(10 / 0.033))
  })
})

describe('recorderFormat', () => {
  it('prefers VP9, and names MP4 files .mp4', () => {
    expect(recorderFormat(() => true)).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' })
    expect(recorderFormat((t) => t === 'video/mp4')).toEqual({ mime: 'video/mp4', ext: 'mp4' })
  })

  it('is null when nothing can be recorded', () => {
    expect(recorderFormat(() => false)).toBeNull()
  })
})

describe('recorderBitrate', () => {
  it('scales with the canvas and stays in range', () => {
    expect(recorderBitrate(1920, 1080)).toBe(1920 * 1080 * TURNTABLE_TUNING.bitsPerPixel)
    expect(recorderBitrate(100, 100)).toBe(TURNTABLE_TUNING.minBitrate)
    expect(recorderBitrate(8000, 8000)).toBe(TURNTABLE_TUNING.maxBitrate)
  })
})
