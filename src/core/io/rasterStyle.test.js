import { describe, it, expect } from 'vitest'
import {
  needsStyling, defaultRasterStyle, resolveRasterStyle, bandsUsedBy,
  percentileRange, minMaxRange, resolveRange, stretchTo255,
  normalizedDifference, composeStyledRgba, describeStyle, styleStamp,
} from './rasterStyle.js'

describe('needsStyling', () => {
  it('leaves an 8-bit RGB ortho on the legacy readRGB path', () => {
    expect(needsStyling({ bands: 3, bitsPerSample: 8, sampleFormat: 1 })).toBe(false)
    expect(needsStyling({ bands: 1, bitsPerSample: 8, sampleFormat: 1 })).toBe(false)
  })
  it('claims anything deeper than 8-bit or wider than 3 bands', () => {
    expect(needsStyling({ bands: 6, bitsPerSample: 16, sampleFormat: 1 })).toBe(true) // Sentinel-2
    expect(needsStyling({ bands: 3, bitsPerSample: 16, sampleFormat: 1 })).toBe(true)
    expect(needsStyling({ bands: 1, bitsPerSample: 32, sampleFormat: 3 })).toBe(true)
  })
})

describe('defaultRasterStyle', () => {
  it('shows the first three bands as RGB with a percentile stretch when deep', () => {
    const s = defaultRasterStyle({ bands: 6, bitsPerSample: 16 })
    expect(s).toMatchObject({ mode: 'rgb', bandR: 0, bandG: 1, bandB: 2, stretch: 'percentile' })
  })
  it('falls back to greyscale on a single-band raster', () => {
    expect(defaultRasterStyle({ bands: 1, bitsPerSample: 16 }).mode).toBe('gray')
  })
})

describe('resolveRasterStyle', () => {
  it('clamps band indices that the raster does not have', () => {
    const s = resolveRasterStyle({ mode: 'rgb', bandR: 9, bandG: 1, bandB: 2 }, { bands: 3 })
    expect(s.bandR).toBe(2)
  })
  it('downgrades an RGB style on a single-band raster rather than faking colour', () => {
    expect(resolveRasterStyle({ mode: 'rgb' }, { bands: 1 }).mode).toBe('gray')
    expect(resolveRasterStyle({ mode: 'index' }, { bands: 1 }).mode).toBe('gray')
  })
  it('repairs nonsense without throwing', () => {
    const s = resolveRasterStyle({ mode: 'nope', stretch: 'nope', gamma: -4, loPct: 90, hiPct: 10 }, { bands: 4 })
    expect(s.mode).toBe('rgb')
    expect(s.stretch).toBe('minmax') // 8-bit default for the given meta
    expect(s.gamma).toBe(1)
    expect(s.hiPct).toBeGreaterThan(s.loPct)
  })
})

describe('bandsUsedBy', () => {
  it('reads only the bands a style names', () => {
    expect(bandsUsedBy({ mode: 'rgb', bandR: 3, bandG: 2, bandB: 1 })).toEqual([3, 2, 1])
    expect(bandsUsedBy({ mode: 'index', bandA: 4, bandB2: 3 })).toEqual([4, 3])
    expect(bandsUsedBy({ mode: 'gray', band: 5 })).toEqual([5])
  })
})

describe('ranges', () => {
  it('percentile ignores the tails that would flatten the image', () => {
    // 100 values 0..99 plus one huge outlier: min-max is dominated by it,
    // the 98th percentile is not.
    const v = [...Array(100).keys()].concat([100000])
    expect(minMaxRange(v)[1]).toBe(100000)
    expect(percentileRange(v, 2, 98)[1]).toBeLessThan(200)
  })
  it('widens a constant band instead of producing a zero-width range', () => {
    expect(minMaxRange([5, 5, 5])).toEqual([5, 6])
  })
  it('returns null for an all-nodata sample', () => {
    expect(minMaxRange([NaN, NaN])).toBeNull()
    expect(percentileRange([])).toBeNull()
  })
  it('honours manual limits over any computed stretch', () => {
    const r = resolveRange([0, 1, 2, 3], { stretch: 'manual' }, [10, 20])
    expect(r).toEqual([10, 20])
  })
  it('ignores an invalid manual range rather than dividing by zero', () => {
    const r = resolveRange([0, 10], { stretch: 'manual' }, [5, 5])
    expect(r).toEqual([0, 10]) // fell through to the percentile default
  })
})

describe('stretchTo255', () => {
  it('maps the range onto the full 0..255 span', () => {
    expect(stretchTo255(0, [0, 100])).toBe(0)
    expect(stretchTo255(100, [0, 100])).toBe(255)
    expect(stretchTo255(50, [0, 100])).toBe(128)
  })
  it('clamps outside the range', () => {
    expect(stretchTo255(-50, [0, 100])).toBe(0)
    expect(stretchTo255(500, [0, 100])).toBe(255)
  })
  it('gamma above 1 brightens midtones', () => {
    expect(stretchTo255(50, [0, 100], 2)).toBeGreaterThan(stretchTo255(50, [0, 100], 1))
  })
  it('is why Sentinel-2 rendered black: the fix lifts ~3000/65535 off the floor', () => {
    // The bug: readRGB scales by the declared bit depth.
    expect(Math.round(255 * (3000 / 65535))).toBeLessThan(15)
    // The fix: stretch to the band's own 2–98% range.
    expect(stretchTo255(3000, percentileRange([500, 1500, 3000, 3500]))).toBeGreaterThan(100)
  })
})

describe('normalizedDifference', () => {
  it('computes (a-b)/(a+b)', () => {
    expect(normalizedDifference(3, 1)).toBeCloseTo(0.5)
    expect(normalizedDifference(1, 3)).toBeCloseTo(-0.5)
  })
  it('is NaN where the sum is zero rather than Infinity', () => {
    expect(Number.isNaN(normalizedDifference(0, 0))).toBe(true)
  })
})

describe('composeStyledRgba', () => {
  const width = 2, height = 1

  it('greyscale writes the same value to all three channels', () => {
    const out = composeStyledRgba({
      width, height, style: { mode: 'gray', gamma: 1 },
      channels: [[0, 100]], ranges: [[0, 100]],
    })
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 255])
    expect([...out.slice(4, 8)]).toEqual([255, 255, 255, 255])
  })

  it('rgb stretches each channel on its OWN range', () => {
    const out = composeStyledRgba({
      width, height, style: { mode: 'rgb', gamma: 1 },
      channels: [[10, 20], [100, 200], [1000, 2000]],
      ranges: [[10, 20], [100, 200], [1000, 2000]],
    })
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 255])
    expect([...out.slice(4, 8)]).toEqual([255, 255, 255, 255])
  })

  it('makes a nodata pixel transparent in every mode', () => {
    const gray = composeStyledRgba({
      width, height, style: { mode: 'gray' },
      channels: [[0, 50]], ranges: [[0, 100]], nodata: 0,
    })
    expect(gray[3]).toBe(0)   // nodata → transparent
    expect(gray[7]).toBe(255)

    // One nodata band poisons the whole RGB pixel — a stack's collar must not
    // render as spurious colour.
    const rgb = composeStyledRgba({
      width, height, style: { mode: 'rgb' },
      channels: [[0, 5], [5, 5], [5, 5]], ranges: [[0, 10], [0, 10], [0, 10]], nodata: 0,
    })
    expect(rgb[3]).toBe(0)
    expect(rgb[7]).toBe(255)
  })

  it('index mode renders on the fixed -1..1 scale, not a stretch', () => {
    // NDVI = 0 must land mid-ramp regardless of the input magnitudes, so the
    // zero crossing stays where it means something.
    const a = composeStyledRgba({
      width: 1, height: 1, style: { mode: 'index', ramp: 'gray', gamma: 1 },
      channels: [[5], [5]],
    })
    const b = composeStyledRgba({
      width: 1, height: 1, style: { mode: 'index', ramp: 'gray', gamma: 1 },
      channels: [[5000], [5000]],
    })
    expect([...a.slice(0, 4)]).toEqual([...b.slice(0, 4)])
    expect(a[0]).toBe(128)
  })

  it('treats a non-finite sample as nodata even without a nodata tag', () => {
    const out = composeStyledRgba({
      width: 1, height: 1, style: { mode: 'gray' }, channels: [[NaN]], ranges: [[0, 1]],
    })
    expect(out[3]).toBe(0)
  })
})

describe('describeStyle', () => {
  it('reports bands 1-indexed, as the UI shows them', () => {
    expect(describeStyle({ mode: 'rgb', bandR: 2, bandG: 1, bandB: 0, stretch: 'percentile', loPct: 2, hiPct: 98 }))
      .toBe('RGB ← bands 3, 2, 1, 2–98%')
    expect(describeStyle({ mode: 'gray', band: 0, stretch: 'minmax' })).toBe('grey ← band 1, min–max')
  })
})

// The stamp is what tells a cached full-resolution plane apart from the style
// currently on screen: a restyle repaints the preview but defers the expensive
// compose, so a stamp that fails to change means the sampler silently serves
// pixels from the OLD style.
describe('styleStamp', () => {
  const base = { mode: 'gray', band: 0, stretch: 'percentile', loPct: 2, hiPct: 98, gamma: 1, ramp: 'rdylgn' }

  it('changes when any pixel-affecting field changes', () => {
    const s0 = styleStamp(base)
    expect(styleStamp({ ...base, band: 1 })).not.toBe(s0)
    expect(styleStamp({ ...base, gamma: 1.4 })).not.toBe(s0)
    expect(styleStamp({ ...base, stretch: 'minmax' })).not.toBe(s0)
    expect(styleStamp({ ...base, hiPct: 95 })).not.toBe(s0)
    expect(styleStamp({ ...base, mode: 'rgb', bandR: 0, bandG: 1, bandB: 2 })).not.toBe(s0)
  })

  it('ignores `ranges` — an echoed output of the last decode, not an input', () => {
    expect(styleStamp({ ...base, ranges: [[0, 1]] })).toBe(styleStamp(base))
  })

  it('tracks manual limits, which do change pixels', () => {
    const m = { ...base, stretch: 'manual', manual: [[0, 100]] }
    expect(styleStamp({ ...m, manual: [[0, 200]] })).not.toBe(styleStamp(m))
  })

  it('does not confuse a band index across modes', () => {
    // gray band 1 and an index whose A band is 1 must not collide.
    expect(styleStamp({ ...base, band: 1 }))
      .not.toBe(styleStamp({ ...base, mode: 'index', index: 'ndvi', bandA: 1, bandB2: 0 }))
  })

  it('is stable for an unstyled raster (DEM / 8-bit fast path)', () => {
    expect(styleStamp(null)).toBe(styleStamp(null))
  })
})
