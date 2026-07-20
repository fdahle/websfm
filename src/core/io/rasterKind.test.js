import { describe, it, expect } from 'vitest'
import { classifyRasterKind, SAMPLE_FORMAT_IEEEFP, SAMPLE_FORMAT_INT } from './rasterKind.js'

// Fixture headers built by hand — the whole point of keeping the classifier pure
// is that these need no geotiff.js decode.
const float32Dem = {
  bands: 1, sampleFormat: SAMPLE_FORMAT_IEEEFP, bitsPerSample: 32,
  nodata: -9999, fileName: 'REMA_32m.tif',
}
const rgbOrtho = { bands: 3, bitsPerSample: 8, fileName: 'mosaic.tif' }
const panOrtho = { bands: 1, bitsPerSample: 8, fileName: 'scan.tif' }

describe('classifyRasterKind', () => {
  it('calls float32 single-band a DEM with high confidence', () => {
    const r = classifyRasterKind(float32Dem)
    expect(r.kind).toBe('dem')
    expect(r.confidence).toBe('high')
    expect(r.reasons[0]).toMatch(/float32/)
  })

  it('calls float DEM before consulting the filename', () => {
    // Deliberately ortho-sounding name; the sample format must still win.
    const r = classifyRasterKind({ ...float32Dem, fileName: 'ortho_rgb_mosaic.tif' })
    expect(r.kind).toBe('dem')
    expect(r.confidence).toBe('high')
  })

  it('treats a nodata tag on a 1-band raster as a DEM signal', () => {
    const r = classifyRasterKind({ bands: 1, bitsPerSample: 16, nodata: -32768, fileName: 'x.tif' })
    expect(r.kind).toBe('dem')
    expect(r.confidence).toBe('high')
    expect(r.reasons[0]).toMatch(/classic elevation sentinel/)
  })

  it('lets band count outweigh a stray nodata tag on 3-band imagery', () => {
    const r = classifyRasterKind({ bands: 3, bitsPerSample: 8, nodata: 0, fileName: 'x.tif' })
    expect(r.kind).toBe('ortho')
    expect(r.confidence).toBe('high')
    // The nodata tag is still reported, so the log explains the near-miss.
    expect(r.reasons.some((s) => /outweighs/.test(s))).toBe(true)
  })

  it('calls 3+ bands imagery', () => {
    expect(classifyRasterKind(rgbOrtho)).toMatchObject({ kind: 'ortho', confidence: 'high' })
    expect(classifyRasterKind({ ...rgbOrtho, bands: 4 })).toMatchObject({ kind: 'ortho', confidence: 'high' })
  })

  it('calls 1-band 8-bit imagery (panchromatic / greyscale scan)', () => {
    expect(classifyRasterKind(panOrtho)).toMatchObject({ kind: 'ortho', confidence: 'high' })
  })

  it('uses VerticalCSTypeGeoKey for a 16-bit single band', () => {
    const r = classifyRasterKind({
      bands: 1, bitsPerSample: 16, geoKeys: { VerticalCSTypeGeoKey: 5773 }, fileName: 'x.tif',
    })
    expect(r).toMatchObject({ kind: 'dem', confidence: 'high' })
  })

  // ── The ambiguous tier: 1-band int16/uint16, resolved only by histogram ──────
  it('reads negative-but-plausible values as elevation, at LOW confidence', () => {
    const values = Int16Array.from({ length: 500 }, (_, i) => -200 + i * 3)
    const r = classifyRasterKind({
      bands: 1, bitsPerSample: 16, sampleFormat: SAMPLE_FORMAT_INT,
      sampledValues: values, fileName: 'x.tif',
    })
    expect(r.kind).toBe('dem')
    expect(r.confidence).toBe('low') // ⇒ the import modal opens
  })

  it('reads a 0–255-confined 16-bit sample as imagery', () => {
    const values = Uint16Array.from({ length: 500 }, (_, i) => i % 256)
    const r = classifyRasterKind({ bands: 1, bitsPerSample: 16, sampledValues: values, fileName: 'x.tif' })
    expect(r).toMatchObject({ kind: 'ortho', confidence: 'low' })
  })

  it('reads a saturating histogram as imagery', () => {
    // 90% of samples pinned at the top of the range — a contrast stretch, not terrain.
    const values = Uint16Array.from({ length: 1000 }, (_, i) => (i < 100 ? i * 60 : 65535))
    const r = classifyRasterKind({ bands: 1, bitsPerSample: 16, sampledValues: values, fileName: 'x.tif' })
    expect(r).toMatchObject({ kind: 'ortho', confidence: 'low' })
  })

  it('reads an all-positive in-range sample as elevation', () => {
    const values = Uint16Array.from({ length: 500 }, (_, i) => 1200 + (i % 400))
    const r = classifyRasterKind({ bands: 1, bitsPerSample: 16, sampledValues: values, fileName: 'x.tif' })
    expect(r).toMatchObject({ kind: 'dem', confidence: 'low' })
  })

  // ── Filename tier ───────────────────────────────────────────────────────────
  it('falls back to the filename when nothing structural decides', () => {
    expect(classifyRasterKind({ bands: 1, bitsPerSample: 16, fileName: 'cop30_n70.tif' }))
      .toMatchObject({ kind: 'dem', confidence: 'low' })
    expect(classifyRasterKind({ bands: 1, bitsPerSample: 16, fileName: 'ortho_2019.tif' }))
      .toMatchObject({ kind: 'ortho', confidence: 'low' })
  })

  it('ignores a filename that reads both ways', () => {
    const r = classifyRasterKind({ bands: 1, bitsPerSample: 16, fileName: 'dem_ortho_test.tif' })
    expect(r.confidence).toBe('low')
    expect(r.reasons.at(-1)).toMatch(/no decisive signal/)
  })

  it('defaults to DEM for an undecidable 1-band 16-bit raster', () => {
    expect(classifyRasterKind({ bands: 1, bitsPerSample: 16, fileName: 'x.tif' }))
      .toMatchObject({ kind: 'dem', confidence: 'low' })
  })

  it('always returns at least one reason', () => {
    for (const input of [float32Dem, rgbOrtho, panOrtho, { bands: 1, bitsPerSample: 16 }]) {
      expect(classifyRasterKind(input).reasons.length).toBeGreaterThan(0)
    }
  })
})
