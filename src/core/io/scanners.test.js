import { describe, expect, it } from 'vitest'
import { filmScannerOf } from './scanners.js'

describe('filmScannerOf', () => {
  it('names a scanner from its make, or from its model where the maker also builds cameras', () => {
    // The XMP of the TMA scans.
    expect(filmScannerOf('Better Light', 'Model Super10K')).toBe('Better Light Model Super10K')
    expect(filmScannerOf('Hasselblad', 'Flextight X5')).toBe('Hasselblad Flextight X5')
    expect(filmScannerOf('Vexcel Imaging', 'UltraScan 5000')).toBe('Vexcel Imaging UltraScan 5000')
    expect(filmScannerOf('Nikon', 'Nikon LS-5000')).toBe('Nikon LS-5000')
  })

  it('leaves the cameras of the same makers alone', () => {
    expect(filmScannerOf('Hasselblad', 'L1D-20c')).toBeNull()
    expect(filmScannerOf('Vexcel Imaging', 'UltraCam Eagle')).toBeNull()
    expect(filmScannerOf('NIKON CORPORATION', 'NIKON D850')).toBeNull()
    expect(filmScannerOf('Leica Camera AG', 'M10')).toBeNull()
    expect(filmScannerOf('DJI', 'FC6310')).toBeNull()
  })

  it('is null without a make or model', () => {
    expect(filmScannerOf(null, null)).toBeNull()
    expect(filmScannerOf('', '')).toBeNull()
  })
})
